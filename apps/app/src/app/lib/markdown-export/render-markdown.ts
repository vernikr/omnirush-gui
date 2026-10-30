import type { Todo } from "@opencode-ai/sdk/v2/client";

import { createCanonicalTranscriptIRWithoutBaseline } from "./canonicalize";
import { computeLosslessFileDelta } from "./file-delta";
import { sha256Hex, shortSha256, utf8ByteLength } from "./hash-and-bytes";
import {
  fenceMarkdownCode,
  normalizeNewlines,
  tryEncodeLosslessToon,
} from "./structured-compact";
import type {
  CanonicalMessageIR,
  CanonicalReadFile,
  CanonicalSessionNodeIR,
  CanonicalToolPartIR,
  CanonicalTranscriptIR,
  CompressionStats,
  ExportableSessionTree,
  ExportMarkdownOptions,
  ExportRenderResult,
} from "./types";
import { RAW_EXPORT_MARKDOWN_OPTIONS } from "./types";

const MIN_DEDUP_NET_WIN_BYTES = 64;
const MIN_RANGE_CANDIDATE_BYTES = 160;
const MIN_RANGE_CANDIDATE_LINES = 3;
const MIN_DELTA_CANDIDATE_BYTES = 200;
const MIN_DELTA_CANDIDATE_LINES = 6;
const MIN_DELTA_NET_WIN_BYTES = 96;
const MIN_DELTA_SAVED_RATIO = 0.2;

type ToolOutputPlan =
  | { kind: "none" }
  | { kind: "raw"; fencedBlock: string }
  | {
      kind: "canonical_read";
      read: CanonicalReadFile;
      fencedBlock: string;
    }
  | {
      kind: "toon_table";
      fencedBlock: string;
      sha256: string;
    }
  | {
      kind: "exact_ref";
      targetCallRefId: string;
      markdownBlock: string;
    }
  | {
      kind: "range_ref";
      targetCallRefId: string;
      markdownBlock: string;
    }
  | {
      kind: "delta_ref";
      targetCallRefId: string;
      markdownBlock: string;
    };

type ToolRenderPlan = {
  inputBlock: string | null;
  outputPlan: ToolOutputPlan;
  outputSourceSha256: string | null;
};

type LosslessPassState = {
  plans: Map<string, ToolRenderPlan>;
  referencedCallIds: Set<string>;
  stats: CompressionStats;
};

function emptyStats(): CompressionStats {
  return {
    exactDedupCount: 0,
    rangeRefCount: 0,
    deltaCount: 0,
    canonicalReadCount: 0,
    compactJsonCount: 0,
    toonTableCount: 0,
    anchorCount: 0,
    savedBytesByDedup: 0,
    savedBytesByRange: 0,
    savedBytesByDelta: 0,
    savedBytesByStructured: 0,
  };
}

function sanitizeInlineLinkCode(value: string): string {
  return value.replace(/[`[\]\r\n]+/g, " ").trim();
}

function formatReadMetaSummary(read: CanonicalReadFile, shaPrefix?: string): string {
  const parts: string[] = [];
  if (read.displayPath) {
    parts.push(`File: \`${sanitizeInlineLinkCode(read.displayPath)}\``);
  }
  if (read.lines.length === 0) {
    parts.push("Empty file (0 lines)");
  } else {
    let rangePart = `Lines L${read.firstLine}–L${read.lastLine}`;
    if (read.footerKind === "eof" && typeof read.totalLines === "number") {
      rangePart += ` (EOF, ${read.totalLines} lines)`;
    } else if (read.footerKind === "partial" && typeof read.totalLines === "number") {
      rangePart += ` of ${read.totalLines} (truncated)`;
    } else if (read.footerKind === "capped_50kb") {
      rangePart += " (capped at 50 KB)";
    } else if (read.footerKind === "more_lines") {
      rangePart += " (truncated)";
    }
    parts.push(rangePart);
  }
  if (shaPrefix) {
    parts.push(`\`sha256:${shaPrefix}\``);
  }
  return `_${parts.join(" · ")}_`;
}

function formatReadShortRangeLabel(read: CanonicalReadFile): string {
  if (read.lines.length === 0) return "0 lines";
  const count = read.lines.length;
  const suffix =
    read.footerKind === "eof"
      ? ", EOF"
      : read.truncated
        ? ", truncated"
        : "";
  return `L${read.firstLine}–L${read.lastLine}, ${count} lines${suffix}`;
}

function renderRawToolOutputBlock(tool: CanonicalToolPartIR): string {
  if (tool.normalizedOutput === null) return "";
  if (tool.prettyOutputJson !== null) {
    return fenceMarkdownCode(tool.prettyOutputJson, "json");
  }
  return fenceMarkdownCode(tool.normalizedOutput);
}

function renderCanonicalReadUnanchored(read: CanonicalReadFile): string {
  const metaLine = formatReadMetaSummary(read);
  if (read.lines.length === 0) return metaLine;
  const bodyFence = fenceMarkdownCode(read.cleanBody, read.fenceLanguage, true);
  return `${metaLine}\n\n${bodyFence}`;
}

function anchorOverheadBytes(callRefId: string, isRead: boolean): number {
  // `<a id="export-ref-c001"></a>\n\n` plus sha256 tag on source caption
  const anchorTag = `<a id="export-ref-${callRefId}"></a>\n\n`;
  const captionExtra = isRead ? " · `sha256:000000000000`" : "_Output (`sha256:000000000000`):_\n\n";
  return utf8ByteLength(anchorTag) + utf8ByteLength(captionExtra);
}

function collectToolsInDocumentOrder(node: CanonicalSessionNodeIR, out: CanonicalToolPartIR[]): void {
  for (const message of node.messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool") continue;
      out.push(part);
      if (part.subagent) {
        collectToolsInDocumentOrder(part.subagent.node, out);
      }
    }
  }
}

function findContainedLineSlice(
  sourceLines: readonly string[],
  sourceFirstLine: number,
  samePath: boolean,
  target: CanonicalReadFile,
): number | null {
  const targetLen = target.lines.length;
  if (targetLen === 0 || targetLen > sourceLines.length) return null;

  // O(1) expected index check when line numbers align on the same file
  if (samePath && target.firstLine >= sourceFirstLine) {
    const directIdx = target.firstLine - sourceFirstLine;
    if (directIdx + targetLen <= sourceLines.length) {
      let match = true;
      for (let i = 0; i < targetLen; i += 1) {
        if (sourceLines[directIdx + i] !== target.lines[i]) {
          match = false;
          break;
        }
      }
      if (match) return directIdx;
    }
  }

  if (!samePath) return null;

  const firstTargetLine = target.lines[0]!;
  const maxStart = sourceLines.length - targetLen;
  for (let start = 0; start <= maxStart; start += 1) {
    if (sourceLines[start] !== firstTargetLine) continue;
    let match = true;
    for (let i = 1; i < targetLen; i += 1) {
      if (sourceLines[start + i] !== target.lines[i]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return null;
}

function buildLosslessPlans(root: CanonicalSessionNodeIR): LosslessPassState {
  const tools: CanonicalToolPartIR[] = [];
  collectToolsInDocumentOrder(root, tools);

  const plans = new Map<string, ToolRenderPlan>();
  const referencedCallIds = new Set<string>();
  const stats = emptyStats();

  const firstByReadBodyHash = new Map<string, CanonicalToolPartIR>();
  const firstByOutputHash = new Map<string, CanonicalToolPartIR>();
  const inlineReadSnapshots: CanonicalToolPartIR[] = [];

  for (const tool of tools) {
    let inputBlock: string | null = null;
    if (tool.hasInput && tool.prettyInputJson !== null) {
      if (tool.compactInputJson !== null) {
        const prettyFenced = fenceMarkdownCode(tool.prettyInputJson, "json");
        const compactFenced = fenceMarkdownCode(tool.compactInputJson, "json");
        const saved = utf8ByteLength(prettyFenced) - utf8ByteLength(compactFenced);
        if (saved > 0) {
          inputBlock = compactFenced;
          stats.compactJsonCount += 1;
          stats.savedBytesByStructured += saved;
        } else {
          inputBlock = prettyFenced;
        }
      } else {
        inputBlock = fenceMarkdownCode(tool.prettyInputJson, "json");
      }
    } else if (tool.pendingRawInput !== null) {
      inputBlock = fenceMarkdownCode(tool.pendingRawInput);
    }

    if (tool.normalizedOutput === null) {
      plans.set(tool.callRefId, {
        inputBlock,
        outputPlan: { kind: "none" },
        outputSourceSha256: null,
      });
      continue;
    }

    const rawBaselineBlock = renderRawToolOutputBlock(tool);
    const rawBaselineBytes = utf8ByteLength(rawBaselineBlock);

    // Branch 1: Canonical OpenCode `Read` file envelope
    if (tool.canonicalRead !== null) {
      const read = tool.canonicalRead;
      const canonicalInlineBlock = renderCanonicalReadUnanchored(read);
      const canonicalInlineBytes = utf8ByteLength(canonicalInlineBlock);

      // Pass B (Read): Exact content-addressed deduplication
      const exactReadMatch = firstByReadBodyHash.get(read.cleanBodySha256);
      if (exactReadMatch && exactReadMatch.canonicalRead) {
        const srcRead = exactReadMatch.canonicalRead;
        const pathLabel = sanitizeInlineLinkCode(read.displayPath || srcRead.displayPath || "file");
        const refBlock = `> [↩ Identical to ${exactReadMatch.turnLabel} · Read \`${pathLabel}\` (${formatReadShortRangeLabel(read)}) · \`sha256:${shortSha256(read.cleanBodySha256)}\`](#export-ref-${exactReadMatch.callRefId})`;
        const extraAnchor = referencedCallIds.has(exactReadMatch.callRefId)
          ? 0
          : anchorOverheadBytes(exactReadMatch.callRefId, true);
        const totalCost = utf8ByteLength(refBlock) + extraAnchor;
        if (rawBaselineBytes - totalCost >= MIN_DEDUP_NET_WIN_BYTES) {
          referencedCallIds.add(exactReadMatch.callRefId);
          stats.exactDedupCount += 1;
          stats.savedBytesByDedup += rawBaselineBytes - totalCost;
          plans.set(tool.callRefId, {
            inputBlock,
            outputPlan: {
              kind: "exact_ref",
              targetCallRefId: exactReadMatch.callRefId,
              markdownBlock: refBlock,
            },
            outputSourceSha256: read.cleanBodySha256,
          });
          continue;
        }
      }

      // Pass C (Read): Line-range containment inside an earlier inline Read snapshot
      const cleanBodyBytes = utf8ByteLength(read.cleanBody);
      if (
        cleanBodyBytes >= MIN_RANGE_CANDIDATE_BYTES &&
        read.lines.length >= MIN_RANGE_CANDIDATE_LINES
      ) {
        let matchedRangePlan: { src: CanonicalToolPartIR; refBlock: string; netSaved: number } | null =
          null;
        for (const candidateTool of inlineReadSnapshots) {
          const srcRead = candidateTool.canonicalRead!;
          const samePath =
            Boolean(read.comparablePath) &&
            Boolean(srcRead.comparablePath) &&
            read.comparablePath === srcRead.comparablePath;
          if (!samePath) continue;

          const sliceIdx = findContainedLineSlice(
            srcRead.lines,
            srcRead.firstLine,
            true,
            read,
          );
          if (sliceIdx === null) continue;

          const slicedBody = srcRead.lines.slice(sliceIdx, sliceIdx + read.lines.length).join("\n");
          if (slicedBody !== read.cleanBody || sha256Hex(slicedBody) !== read.cleanBodySha256) {
            continue;
          }

          const sliceStart1 = sliceIdx + 1;
          const sliceEnd1 = sliceIdx + read.lines.length;
          const pathLabel = sanitizeInlineLinkCode(read.displayPath || srcRead.displayPath || "file");
          const refBlock = `> [↩ Contained in ${candidateTool.turnLabel} · Read \`${pathLabel}\`: lines L${read.firstLine}–L${read.lastLine} (slice ${sliceStart1}..${sliceEnd1}, ${read.lines.length} lines) · \`sha256:${shortSha256(read.cleanBodySha256)}\`](#export-ref-${candidateTool.callRefId})`;
          const extraAnchor = referencedCallIds.has(candidateTool.callRefId)
            ? 0
            : anchorOverheadBytes(candidateTool.callRefId, true);
          const totalCost = utf8ByteLength(refBlock) + extraAnchor;
          const netSaved = rawBaselineBytes - totalCost;
          if (netSaved >= MIN_DEDUP_NET_WIN_BYTES) {
            matchedRangePlan = { src: candidateTool, refBlock, netSaved };
            break;
          }
        }

        if (matchedRangePlan) {
          referencedCallIds.add(matchedRangePlan.src.callRefId);
          stats.rangeRefCount += 1;
          stats.savedBytesByRange += matchedRangePlan.netSaved;
          plans.set(tool.callRefId, {
            inputBlock,
            outputPlan: {
              kind: "range_ref",
              targetCallRefId: matchedRangePlan.src.callRefId,
              markdownBlock: matchedRangePlan.refBlock,
            },
            outputSourceSha256: read.cleanBodySha256,
          });
          if (!firstByReadBodyHash.has(read.cleanBodySha256)) {
            firstByReadBodyHash.set(read.cleanBodySha256, tool);
          }
          continue;
        }
      }

      // Pass D (Read): 1-hop post-edit file delta against the most recent inline Read snapshot of the same file
      if (
        Boolean(read.comparablePath) &&
        cleanBodyBytes >= MIN_DELTA_CANDIDATE_BYTES &&
        read.lines.length >= MIN_DELTA_CANDIDATE_LINES
      ) {
        let bestDelta: { src: CanonicalToolPartIR; markdownBlock: string; netSaved: number } | null =
          null;
        for (let idx = inlineReadSnapshots.length - 1; idx >= 0; idx -= 1) {
          const baseTool = inlineReadSnapshots[idx]!;
          const baseRead = baseTool.canonicalRead!;
          if (baseRead.comparablePath !== read.comparablePath) continue;
          if (baseRead.lines.length === 0) continue;

          const deltaBody = computeLosslessFileDelta(
            baseRead.lines,
            read.lines,
            read.cleanBodySha256,
          );
          if (!deltaBody) continue;

          const pathLabel = sanitizeInlineLinkCode(read.displayPath || baseRead.displayPath || "file");
          const deltaHeader = `> [Δ Delta for \`${pathLabel}\` (${formatReadShortRangeLabel(read)}) from ${baseTool.turnLabel} · Read (L${baseRead.firstLine}–L${baseRead.lastLine}) · base \`sha256:${shortSha256(baseRead.cleanBodySha256)}\` → \`sha256:${shortSha256(read.cleanBodySha256)}\`](#export-ref-${baseTool.callRefId})`;
          const fencedDelta = fenceMarkdownCode(deltaBody, "diff", true);
          const markdownBlock = `${deltaHeader}\n\n${fencedDelta}`;
          const extraAnchor = referencedCallIds.has(baseTool.callRefId)
            ? 0
            : anchorOverheadBytes(baseTool.callRefId, true);
          const totalCost = utf8ByteLength(markdownBlock) + extraAnchor;
          const savedVsCanonical = canonicalInlineBytes - totalCost;
          if (
            savedVsCanonical >= MIN_DELTA_NET_WIN_BYTES &&
            savedVsCanonical / canonicalInlineBytes >= MIN_DELTA_SAVED_RATIO &&
            rawBaselineBytes - totalCost >= MIN_DELTA_NET_WIN_BYTES
          ) {
            bestDelta = {
              src: baseTool,
              markdownBlock,
              netSaved: rawBaselineBytes - totalCost,
            };
            break;
          }
        }

        if (bestDelta) {
          referencedCallIds.add(bestDelta.src.callRefId);
          stats.deltaCount += 1;
          stats.savedBytesByDelta += bestDelta.netSaved;
          plans.set(tool.callRefId, {
            inputBlock,
            outputPlan: {
              kind: "delta_ref",
              targetCallRefId: bestDelta.src.callRefId,
              markdownBlock: bestDelta.markdownBlock,
            },
            outputSourceSha256: read.cleanBodySha256,
          });
          if (!firstByReadBodyHash.has(read.cleanBodySha256)) {
            firstByReadBodyHash.set(read.cleanBodySha256, tool);
          }
          continue;
        }
      }

      // Pass E (Read): Emit canonical stripped Read block when smaller than raw OpenCode XML envelope
      if (canonicalInlineBytes < rawBaselineBytes) {
        stats.canonicalReadCount += 1;
        stats.savedBytesByStructured += rawBaselineBytes - canonicalInlineBytes;
        plans.set(tool.callRefId, {
          inputBlock,
          outputPlan: {
            kind: "canonical_read",
            read,
            fencedBlock:
              read.lines.length === 0
                ? ""
                : fenceMarkdownCode(read.cleanBody, read.fenceLanguage, true),
          },
          outputSourceSha256: read.cleanBodySha256,
        });
        if (read.lines.length > 0) {
          if (!firstByReadBodyHash.has(read.cleanBodySha256)) {
            firstByReadBodyHash.set(read.cleanBodySha256, tool);
          }
          inlineReadSnapshots.push(tool);
        }
        continue;
      }
    }

    // Branch 2: General tool output (Bash, Grep, Glob, JSON/MCP, directory Read, error live output, etc.)
    if (tool.outputSha256 !== null) {
      const exactMatch = firstByOutputHash.get(tool.outputSha256);
      if (exactMatch) {
        const refBlock = `> [↩ Identical output to ${exactMatch.turnLabel} · ${sanitizeInlineLinkCode(exactMatch.displayName)} (${tool.outputLineCount} lines, ${tool.outputBytes.toLocaleString("en-US")} B) · \`sha256:${shortSha256(tool.outputSha256)}\`](#export-ref-${exactMatch.callRefId})`;
        const extraAnchor = referencedCallIds.has(exactMatch.callRefId)
          ? 0
          : anchorOverheadBytes(exactMatch.callRefId, false);
        const totalCost = utf8ByteLength(refBlock) + extraAnchor;
        if (rawBaselineBytes - totalCost >= MIN_DEDUP_NET_WIN_BYTES) {
          referencedCallIds.add(exactMatch.callRefId);
          stats.exactDedupCount += 1;
          stats.savedBytesByDedup += rawBaselineBytes - totalCost;
          plans.set(tool.callRefId, {
            inputBlock,
            outputPlan: {
              kind: "exact_ref",
              targetCallRefId: exactMatch.callRefId,
              markdownBlock: refBlock,
            },
            outputSourceSha256: tool.outputSha256,
          });
          continue;
        }
      }

      firstByOutputHash.set(tool.outputSha256, tool);

      // Pass E (Tabular JSON): Try strictly lossless TOON-JSON v1 encoding on uniform JSON object arrays
      if (tool.parsedOutputJson !== undefined && tool.prettyOutputJson !== null) {
        const toonBody = tryEncodeLosslessToon(tool.parsedOutputJson, tool.prettyOutputJson);
        if (toonBody !== null) {
          const toonFenced = fenceMarkdownCode(toonBody, "toon");
          const saved = rawBaselineBytes - utf8ByteLength(toonFenced);
          if (saved >= MIN_DEDUP_NET_WIN_BYTES) {
            stats.toonTableCount += 1;
            stats.savedBytesByStructured += saved;
            plans.set(tool.callRefId, {
              inputBlock,
              outputPlan: {
                kind: "toon_table",
                fencedBlock: toonFenced,
                sha256: tool.outputSha256,
              },
              outputSourceSha256: tool.outputSha256,
            });
            continue;
          }
        }
      }
    }

    plans.set(tool.callRefId, {
      inputBlock,
      outputPlan: {
        kind: "raw",
        fencedBlock: rawBaselineBlock,
      },
      outputSourceSha256: tool.outputSha256,
    });
  }

  stats.anchorCount = referencedCallIds.size;
  return { plans, referencedCallIds, stats };
}

function headingHashes(depth: number): string {
  const clamped = Math.min(6, Math.max(1, depth));
  return "#".repeat(clamped);
}

function renderBlockquote(headerLine: string | null, text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  const quoted = lines.map((line) => (line.length > 0 ? `> ${line}` : ">"));
  if (headerLine) {
    return [`> ${headerLine}`, ...quoted].join("\n");
  }
  return quoted.join("\n");
}

function formatIsoTimestamp(epochMs: number | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  try {
    return new Date(epochMs).toISOString().replace(".000Z", "Z");
  } catch {
    return null;
  }
}

function renderToolFromIR(
  tool: CanonicalToolPartIR,
  options: ExportMarkdownOptions,
  lossless: LosslessPassState | null,
): string {
  const header = `**🛠 ${tool.displayName}**${tool.stateTitle}${tool.statusSuffix}`;
  const blocks: string[] = [];
  const plan = lossless ? lossless.plans.get(tool.callRefId) : undefined;
  const isAnchored = Boolean(lossless && lossless.referencedCallIds.has(tool.callRefId));

  if (plan) {
    if (plan.inputBlock !== null) {
      blocks.push(plan.inputBlock);
    }
    const out = plan.outputPlan;
    switch (out.kind) {
      case "none":
        break;
      case "canonical_read": {
        if (isAnchored) {
          blocks.push(`<a id="export-ref-${tool.callRefId}"></a>`);
          blocks.push(formatReadMetaSummary(out.read, shortSha256(out.read.cleanBodySha256)));
        } else {
          blocks.push(formatReadMetaSummary(out.read));
        }
        if (out.fencedBlock) {
          blocks.push(out.fencedBlock);
        }
        break;
      }
      case "toon_table": {
        if (isAnchored) {
          blocks.push(`<a id="export-ref-${tool.callRefId}"></a>`);
          blocks.push(`_Output (\`sha256:${shortSha256(out.sha256)}\`):_`);
        }
        blocks.push(out.fencedBlock);
        break;
      }
      case "raw": {
        if (isAnchored && plan.outputSourceSha256) {
          blocks.push(`<a id="export-ref-${tool.callRefId}"></a>`);
          blocks.push(`_Output (\`sha256:${shortSha256(plan.outputSourceSha256)}\`):_`);
        }
        blocks.push(out.fencedBlock);
        break;
      }
      case "exact_ref":
      case "range_ref":
      case "delta_ref": {
        if (isAnchored) {
          blocks.push(`<a id="export-ref-${tool.callRefId}"></a>`);
        }
        blocks.push(out.markdownBlock);
        break;
      }
    }
  } else {
    if (tool.hasInput && tool.prettyInputJson !== null) {
      blocks.push(fenceMarkdownCode(tool.prettyInputJson, "json"));
    } else if (tool.pendingRawInput !== null) {
      blocks.push(fenceMarkdownCode(tool.pendingRawInput));
    }
    if (tool.normalizedOutput !== null) {
      blocks.push(renderRawToolOutputBlock(tool));
    }
  }

  if (tool.attachmentLabels.length > 0) {
    blocks.push(`> Tool attachments: ${tool.attachmentLabels.join(", ")}`);
  }
  if (tool.errorText !== null) {
    blocks.push(`_Error:_\n${fenceMarkdownCode(tool.errorText)}`);
  }

  const toolSection =
    blocks.length === 0
      ? `${header} _(no input or output)_`
      : `${header}\n\n${blocks.join("\n\n")}`;

  if (!tool.subagent) {
    return toolSection;
  }

  const subHeading = headingHashes(tool.subagent.headingDepth);
  const subBody = renderSessionNodeMessages(tool.subagent.node, options, lossless);
  const subSection = subBody.markdown
    ? `${subHeading} ⤷ Subagent: ${tool.subagent.label}\n\n${subBody.markdown}\n\n${subHeading} ⤶ End subagent`
    : `${subHeading} ⤷ Subagent: ${tool.subagent.label}\n\n_(no recorded subagent turns)_\n\n${subHeading} ⤶ End subagent`;

  return `${toolSection}\n\n${subSection}`;
}

function renderMessageBlocks(
  message: CanonicalMessageIR,
  options: ExportMarkdownOptions,
  lossless: LosslessPassState | null,
): string[] {
  const blocks: string[] = [];

  for (const part of message.parts) {
    switch (part.kind) {
      case "reasoning": {
        if (!options.includeReasoning) break;
        blocks.push(renderBlockquote("_Reasoning_", part.text));
        break;
      }
      case "text": {
        blocks.push(part.text);
        break;
      }
      case "attachments": {
        blocks.push(`> Attached files: ${part.labels.join(", ")}`);
        break;
      }
      case "tool": {
        if (!options.includeToolCalls) break;
        blocks.push(renderToolFromIR(part, options, lossless));
        break;
      }
      case "subtask": {
        const subtaskHeader = `**Subtask (\`${part.agent}\`):** ${part.description}`;
        if (part.prompt) {
          blocks.push(`${subtaskHeader}\n\n${renderBlockquote(null, part.prompt)}`);
        } else {
          blocks.push(subtaskHeader);
        }
        break;
      }
      case "patch": {
        blocks.push(`> Patched files: ${part.files.map((file) => `\`${file}\``).join(", ")}`);
        break;
      }
      case "agent": {
        blocks.push(`> Agent: \`@${part.name}\``);
        break;
      }
      case "retry": {
        const retryMsg = part.formattedError ?? `> _Retry attempt ${part.attempt}_`;
        blocks.push(`> _Retry attempt ${part.attempt}_\n${retryMsg}`);
        break;
      }
      case "compaction": {
        blocks.push(part.auto ? "> _Context compacted automatically_" : "> _Context compacted_");
        break;
      }
    }
  }

  if (message.formattedAssistantError) {
    blocks.push(message.formattedAssistantError);
  }

  return blocks;
}

function renderSessionNodeMessages(
  node: CanonicalSessionNodeIR,
  options: ExportMarkdownOptions,
  lossless: LosslessPassState | null,
): { markdown: string; renderedTurnCount: number } {
  const turnHeading = headingHashes(node.headingDepth);
  const renderedTurns: string[] = [];

  for (const message of node.messages) {
    const blocks = renderMessageBlocks(message, options, lossless);
    if (blocks.length === 0) continue;

    const roleTitle = message.info.role === "user" ? "User" : "Assistant";
    const metaParts: string[] = [];
    if (message.info.role === "assistant") {
      const modelLabel =
        message.info.providerID && message.info.modelID
          ? `${message.info.providerID}/${message.info.modelID}`
          : message.info.modelID || "";
      if (message.info.agent?.trim()) {
        metaParts.push(`Agent: \`${message.info.agent.trim()}\``);
      }
      if (modelLabel) {
        metaParts.push(`Model: \`${modelLabel}\``);
      }
    } else if (message.info.model?.modelID) {
      const userModel = message.info.model.providerID
        ? `${message.info.model.providerID}/${message.info.model.modelID}`
        : message.info.model.modelID;
      if (message.info.agent?.trim()) {
        metaParts.push(`Agent: \`${message.info.agent.trim()}\``);
      }
      if (userModel) {
        metaParts.push(`Model: \`${userModel}\``);
      }
    }

    const metaLine = metaParts.length > 0 ? `\n_${metaParts.join(" · ")}_\n` : "\n";
    renderedTurns.push(`${turnHeading} ${roleTitle}${metaLine}\n${blocks.join("\n\n")}`);
  }

  return {
    markdown: renderedTurns.join("\n\n---\n\n"),
    renderedTurnCount: renderedTurns.length,
  };
}

function renderTodosSection(todos: ReadonlyArray<Todo>): string | null {
  if (todos.length === 0) return null;
  const lines: string[] = [];
  for (const todo of todos) {
    const content = todo.content.trim();
    if (!content) continue;
    const checked = todo.status === "completed" ? "x" : " ";
    const statusNote =
      todo.status === "in_progress"
        ? " _(in progress)_"
        : todo.status === "cancelled"
          ? " _(cancelled)_"
          : "";
    lines.push(`- [${checked}] ${content}${statusNote}`);
  }
  if (lines.length === 0) return null;
  return `## Tasks\n\n${lines.join("\n")}`;
}

function renderMarkdownInternal(
  ir: Omit<CanonicalTranscriptIR, "baselineBytes">,
  options: ExportMarkdownOptions,
): { markdown: string; stats: CompressionStats } {
  const useLossless = options.includeToolCalls && options.compression !== "off";
  const lossless = useLossless ? buildLosslessPlans(ir.root) : null;
  const stats = lossless ? lossless.stats : emptyStats();

  const bodyResult = renderSessionNodeMessages(ir.root, options, lossless);
  const rawTitle = ir.root.session.title?.trim() ?? "";
  const title = rawTitle ? normalizeNewlines(rawTitle).replace(/\n+/g, " ") : "OmniRush conversation";

  const countLabel = `${bodyResult.renderedTurnCount} ${bodyResult.renderedTurnCount === 1 ? "message" : "messages"}`;
  const metadataBullets: string[] = [];

  if (ir.root.session.directory?.trim()) {
    metadataBullets.push(`- **Workspace:** \`${ir.root.session.directory.trim()}\``);
  }
  if (ir.root.session.parentID?.trim()) {
    metadataBullets.push(`- **Parent session:** \`${ir.root.session.parentID.trim()}\``);
  }
  const createdIso = formatIsoTimestamp(ir.root.session.time?.created);
  const updatedIso = formatIsoTimestamp(ir.root.session.time?.updated);
  if (createdIso && updatedIso && createdIso !== updatedIso) {
    metadataBullets.push(`- **Created:** ${createdIso} · **Updated:** ${updatedIso}`);
  } else if (createdIso) {
    metadataBullets.push(`- **Created:** ${createdIso}`);
  }
  if (ir.models.length > 0) {
    metadataBullets.push(`- **Models:** ${ir.models.map((m) => `\`${m}\``).join(", ")}`);
  }
  if (ir.totalInputTokens > 0 || ir.totalOutputTokens > 0 || ir.totalReasoningTokens > 0) {
    const tokenParts = [
      `${ir.totalInputTokens.toLocaleString("en-US")} input`,
      `${ir.totalOutputTokens.toLocaleString("en-US")} output`,
    ];
    if (ir.totalReasoningTokens > 0) {
      tokenParts.push(`${ir.totalReasoningTokens.toLocaleString("en-US")} reasoning`);
    }
    const costSuffix = ir.totalCost > 0 ? ` ($${ir.totalCost.toFixed(4)})` : "";
    metadataBullets.push(`- **Tokens:** ${tokenParts.join(", ")}${costSuffix}`);
  }

  const omittedItems: string[] = [];
  if (!options.includeToolCalls) omittedItems.push("tool calls");
  if (!options.includeReasoning) omittedItems.push("reasoning");
  if (omittedItems.length > 0) {
    metadataBullets.push(`- **Omitted:** ${omittedItems.join(", ")}`);
  }

  const totalGrossSaved =
    stats.savedBytesByDedup +
    stats.savedBytesByRange +
    stats.savedBytesByDelta +
    stats.savedBytesByStructured;

  if (useLossless && totalGrossSaved >= 128) {
    const summaryParts: string[] = [];
    if (stats.exactDedupCount > 0) summaryParts.push(`${stats.exactDedupCount} deduplicated`);
    if (stats.rangeRefCount > 0) summaryParts.push(`${stats.rangeRefCount} range refs`);
    if (stats.deltaCount > 0) summaryParts.push(`${stats.deltaCount} deltas`);
    if (stats.toonTableCount > 0) summaryParts.push(`${stats.toonTableCount} TOON tables`);
    const detailSuffix = summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : "";
    metadataBullets.push(`- **Compression:** \`${options.compression}\`${detailSuffix}`);
  }

  const headerLines = [
    `# ${title}`,
    `_${countLabel} · Session \`${ir.root.session.id}\`_`,
  ];
  if (metadataBullets.length > 0) {
    headerLines.push("", ...metadataBullets);
  }

  const sections = [headerLines.join("\n")];
  if (bodyResult.markdown) {
    sections.push(bodyResult.markdown);
  } else {
    sections.push("_(no messages in this branch)_");
  }

  const todosSection = renderTodosSection(ir.todos);
  if (todosSection) {
    sections.push(todosSection);
  }

  return {
    markdown: `${sections.join("\n\n---\n\n")}\n`,
    stats,
  };
}

/**
 * Build a reusable, pre-parsed, pre-hashed canonical Intermediate Representation
 * of a session export tree so interactive checkbox / compression toggles can
 * recompute exact output bytes in milliseconds without re-fetching or re-hashing.
 */
export function buildCanonicalTranscriptIR(tree: ExportableSessionTree): CanonicalTranscriptIR {
  const base = createCanonicalTranscriptIRWithoutBaseline(tree);
  const rawRendered = renderMarkdownInternal(base, RAW_EXPORT_MARKDOWN_OPTIONS);
  return {
    ...base,
    baselineBytes: utf8ByteLength(rawRendered.markdown),
  };
}

/**
 * Synchronously render Markdown and compute exact UTF-8 byte metrics from a
 * pre-built `CanonicalTranscriptIR`.
 */
export function renderTranscriptFromIR(
  ir: CanonicalTranscriptIR,
  partialOptions?: Partial<ExportMarkdownOptions>,
): ExportRenderResult {
  const options: ExportMarkdownOptions = {
    includeToolCalls: partialOptions?.includeToolCalls ?? RAW_EXPORT_MARKDOWN_OPTIONS.includeToolCalls,
    includeReasoning: partialOptions?.includeReasoning ?? RAW_EXPORT_MARKDOWN_OPTIONS.includeReasoning,
    compression: partialOptions?.compression ?? RAW_EXPORT_MARKDOWN_OPTIONS.compression,
  };

  let rendered = renderMarkdownInternal(ir, options);
  let utf8Bytes = utf8ByteLength(rendered.markdown);

  // Strict document-level monotonicity guard: lossless compression of the full
  // transcript must never produce a file larger than the raw baseline.
  if (
    options.includeToolCalls &&
    options.includeReasoning &&
    options.compression !== "off" &&
    utf8Bytes > ir.baselineBytes
  ) {
    rendered = renderMarkdownInternal(ir, RAW_EXPORT_MARKDOWN_OPTIONS);
    utf8Bytes = ir.baselineBytes;
  }

  const savedBytes = Math.max(0, ir.baselineBytes - utf8Bytes);
  const savedRatio = ir.baselineBytes > 0 ? savedBytes / ir.baselineBytes : 0;
  const estimatedTokens = Math.ceil(utf8Bytes / 4);

  return {
    markdown: rendered.markdown,
    utf8Bytes,
    baselineBytes: ir.baselineBytes,
    savedBytes,
    savedRatio,
    estimatedTokens,
    stats: rendered.stats,
  };
}
