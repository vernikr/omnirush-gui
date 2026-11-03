import { applyLosslessFileDelta } from "./file-delta";
import { sha256Hex } from "./hash-and-bytes";
import {
  decodeLosslessToon,
  normalizeNewlines,
  safeJsonStringify,
  TOON_HEADER_LINE,
} from "./structured-compact";
import type { CanonicalTranscriptIR, ExpandedLosslessBlock } from "./types";

const ANCHOR_LINE_PATTERN = /^<a id="(export-ref-c\d+)"><\/a>$/;
const CAPTION_SHA_PATTERN = /`sha256:([0-9a-f]{12})`_$/;
const EXACT_REF_PATTERN =
  /^> \[↩ Identical (?:output )?to .+ · `sha256:([0-9a-f]{12})`\]\(#(export-ref-c\d+)\)$/;
const RANGE_REF_PATTERN =
  /^> \[↩ Contained in .+\(slice (\d+)\.\.(\d+), (\d+) lines\) · `sha256:([0-9a-f]{12})`\]\(#(export-ref-c\d+)\)$/;
const DELTA_REF_PATTERN =
  /^> \[Δ Delta for .+ · base `sha256:([0-9a-f]{12})` → `sha256:([0-9a-f]{12})`\]\(#(export-ref-c\d+)\)$/;
const FENCE_OPEN_PATTERN = /^(`{3,})([^`]*)$/;

function readFencedBlockAt(
  lines: readonly string[],
  openLineIndex: number,
): { lang: string; body: string; nextIndex: number } {
  const openLine = lines[openLineIndex] ?? "";
  const m = FENCE_OPEN_PATTERN.exec(openLine);
  if (!m) {
    throw new Error(`Expected fenced code block at line ${openLineIndex + 1}`);
  }
  const fenceLen = m[1]!.length;
  const lang = m[2]!.trim();
  const closePattern = new RegExp(`^\`{${fenceLen},}\\s*$`);

  const bodyLines: string[] = [];
  for (let idx = openLineIndex + 1; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (closePattern.test(line)) {
      return {
        lang,
        body: bodyLines.join("\n"),
        nextIndex: idx + 1,
      };
    }
    bodyLines.push(line);
  }
  throw new Error(`Unclosed fenced code block opened at line ${openLineIndex + 1}`);
}

/**
 * Self-contained lossless Markdown verifier & expander.
 *
 * Parses an exported `.md` document alone (zero external database or session state),
 * resolves every `#export-ref-...` exact reference, line-range slice, 1-hop file delta,
 * and `TOON-JSON v1` table, and verifies every embedded `sha256:...` digest.
 */
export function expandLosslessMarkdown(markdown: string): ExpandedLosslessBlock[] {
  const lines = normalizeNewlines(markdown).split("\n");
  const resolvedAnchors = new Map<string, string>();
  const results: ExpandedLosslessBlock[] = [];

  let pendingAnchorId: string | null = null;
  let pendingShaPrefix: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 1. Fenced code block (tracked on ALL blocks so inner example text is never misread as anchors/refs)
    if (FENCE_OPEN_PATTERN.test(line)) {
      const fenced = readFencedBlockAt(lines, i);
      i = fenced.nextIndex;

      if (fenced.lang === "toon" && fenced.body.startsWith(TOON_HEADER_LINE)) {
        const decoded = decodeLosslessToon(fenced.body);
        const prettyJson = safeJsonStringify(decoded, 2);
        const digest = sha256Hex(prettyJson);
        if (pendingShaPrefix && !digest.startsWith(pendingShaPrefix)) {
          throw new Error(
            `Source TOON SHA-256 mismatch at ${pendingAnchorId ?? "unanchored"}: expected ${pendingShaPrefix}, got ${digest}`,
          );
        }
        if (pendingAnchorId) {
          resolvedAnchors.set(pendingAnchorId, prettyJson);
          results.push({
            kind: "source",
            anchorId: pendingAnchorId,
            expectedSha256Prefix: pendingShaPrefix ?? undefined,
            reconstructedText: prettyJson,
            actualSha256: digest,
          });
        }
        results.push({
          kind: "toon_table",
          anchorId: pendingAnchorId ?? undefined,
          reconstructedText: prettyJson,
          actualSha256: digest,
        });
        pendingAnchorId = null;
        pendingShaPrefix = null;
        continue;
      }

      if (pendingAnchorId) {
        const digest = sha256Hex(fenced.body);
        if (pendingShaPrefix && !digest.startsWith(pendingShaPrefix)) {
          throw new Error(
            `Source block SHA-256 mismatch at ${pendingAnchorId}: expected ${pendingShaPrefix}, got ${digest}`,
          );
        }
        resolvedAnchors.set(pendingAnchorId, fenced.body);
        results.push({
          kind: "source",
          anchorId: pendingAnchorId,
          expectedSha256Prefix: pendingShaPrefix ?? undefined,
          reconstructedText: fenced.body,
          actualSha256: digest,
        });
        pendingAnchorId = null;
        pendingShaPrefix = null;
      }
      continue;
    }

    // 2. HTML anchor marker
    const anchorMatch = ANCHOR_LINE_PATTERN.exec(line.trim());
    if (anchorMatch) {
      pendingAnchorId = anchorMatch[1]!;
      pendingShaPrefix = null;
      i += 1;
      continue;
    }

    // 3. Caption carrying source SHA-256 right after an anchor
    if (pendingAnchorId && line.startsWith("_")) {
      const shaMatch = CAPTION_SHA_PATTERN.exec(line.trim());
      if (shaMatch) {
        pendingShaPrefix = shaMatch[1]!;
      }
      i += 1;
      continue;
    }

    // 4. Exact deduplication reference
    const exactMatch = EXACT_REF_PATTERN.exec(line.trim());
    if (exactMatch) {
      const expectedSha = exactMatch[1]!;
      const targetAnchor = exactMatch[2]!;
      const baseText = resolvedAnchors.get(targetAnchor);
      if (baseText === undefined) {
        throw new Error(`Unresolved exact reference target #${targetAnchor}`);
      }
      const actualSha = sha256Hex(baseText);
      if (!actualSha.startsWith(expectedSha)) {
        throw new Error(
          `Exact ref SHA-256 mismatch for #${targetAnchor}: expected ${expectedSha}, got ${actualSha}`,
        );
      }
      if (pendingAnchorId) {
        resolvedAnchors.set(pendingAnchorId, baseText);
      }
      results.push({
        kind: "exact_ref",
        anchorId: pendingAnchorId ?? undefined,
        targetAnchorId: targetAnchor,
        expectedSha256Prefix: expectedSha,
        reconstructedText: baseText,
        actualSha256: actualSha,
      });
      pendingAnchorId = null;
      pendingShaPrefix = null;
      i += 1;
      continue;
    }

    // 5. Line-range containment reference
    const rangeMatch = RANGE_REF_PATTERN.exec(line.trim());
    if (rangeMatch) {
      const sliceStart1 = Number(rangeMatch[1]);
      const sliceEnd1 = Number(rangeMatch[2]);
      const expectedLines = Number(rangeMatch[3]);
      const expectedSha = rangeMatch[4]!;
      const targetAnchor = rangeMatch[5]!;

      const baseText = resolvedAnchors.get(targetAnchor);
      if (baseText === undefined) {
        throw new Error(`Unresolved range reference target #${targetAnchor}`);
      }
      const baseLines = baseText.split("\n");
      if (
        sliceStart1 < 1 ||
        sliceEnd1 < sliceStart1 ||
        sliceEnd1 > baseLines.length ||
        sliceEnd1 - sliceStart1 + 1 !== expectedLines
      ) {
        throw new Error(
          `Invalid slice ${sliceStart1}..${sliceEnd1} against #${targetAnchor} (${baseLines.length} lines)`,
        );
      }
      const slicedText = baseLines.slice(sliceStart1 - 1, sliceEnd1).join("\n");
      const actualSha = sha256Hex(slicedText);
      if (!actualSha.startsWith(expectedSha)) {
        throw new Error(
          `Range ref SHA-256 mismatch for #${targetAnchor}: expected ${expectedSha}, got ${actualSha}`,
        );
      }
      if (pendingAnchorId) {
        resolvedAnchors.set(pendingAnchorId, slicedText);
      }
      results.push({
        kind: "range_ref",
        anchorId: pendingAnchorId ?? undefined,
        targetAnchorId: targetAnchor,
        expectedSha256Prefix: expectedSha,
        reconstructedText: slicedText,
        actualSha256: actualSha,
      });
      pendingAnchorId = null;
      pendingShaPrefix = null;
      i += 1;
      continue;
    }

    // 6. Post-edit file delta reference
    const deltaMatch = DELTA_REF_PATTERN.exec(line.trim());
    if (deltaMatch) {
      const expectedBaseSha = deltaMatch[1]!;
      const expectedTargetSha = deltaMatch[2]!;
      const targetAnchor = deltaMatch[3]!;

      const baseText = resolvedAnchors.get(targetAnchor);
      if (baseText === undefined) {
        throw new Error(`Unresolved delta base anchor #${targetAnchor}`);
      }
      const actualBaseSha = sha256Hex(baseText);
      if (!actualBaseSha.startsWith(expectedBaseSha)) {
        throw new Error(
          `Delta base SHA-256 mismatch for #${targetAnchor}: expected ${expectedBaseSha}, got ${actualBaseSha}`,
        );
      }

      let diffIdx = i + 1;
      while (diffIdx < lines.length && lines[diffIdx]!.trim() === "") {
        diffIdx += 1;
      }
      const diffBlock = readFencedBlockAt(lines, diffIdx);
      if (diffBlock.lang !== "diff") {
        throw new Error(`Expected diff fenced block after delta header, got '${diffBlock.lang}'`);
      }

      const reconstructedLines = applyLosslessFileDelta(baseText.split("\n"), diffBlock.body);
      const reconstructedText = reconstructedLines.join("\n");
      const actualTargetSha = sha256Hex(reconstructedText);
      if (!actualTargetSha.startsWith(expectedTargetSha)) {
        throw new Error(
          `Delta target SHA-256 mismatch: expected ${expectedTargetSha}, got ${actualTargetSha}`,
        );
      }

      if (pendingAnchorId) {
        resolvedAnchors.set(pendingAnchorId, reconstructedText);
      }
      results.push({
        kind: "delta_ref",
        anchorId: pendingAnchorId ?? undefined,
        targetAnchorId: targetAnchor,
        expectedSha256Prefix: expectedTargetSha,
        reconstructedText,
        actualSha256: actualTargetSha,
      });
      pendingAnchorId = null;
      pendingShaPrefix = null;
      i = diffBlock.nextIndex;
      continue;
    }

    // Clear stale pending anchor if a section divider or new tool header begins without consuming it
    if (pendingAnchorId && (line === "---" || line.startsWith("**🛠 ") || line.startsWith("## "))) {
      throw new Error(`Dangling unconsumed export anchor #${pendingAnchorId}`);
    }

    i += 1;
  }

  if (pendingAnchorId) {
    throw new Error(`Dangling unconsumed export anchor #${pendingAnchorId} at EOF`);
  }

  return results;
}

/**
 * Assert that every compressed reference/delta/TOON block in `markdown` expands
 * cleanly and matches the canonical SHA-256 digests in `ir`.
 */
export function verifyLosslessRoundTrip(
  ir: CanonicalTranscriptIR,
  markdown: string,
): { verifiedBlocks: ExpandedLosslessBlock[] } {
  const verifiedBlocks = expandLosslessMarkdown(markdown);
  const validDigests = new Set<string>();

  const walk = (node: CanonicalTranscriptIR["root"]) => {
    for (const msg of node.messages) {
      for (const part of msg.parts) {
        if (part.kind !== "tool") continue;
        if (part.canonicalRead) {
          validDigests.add(part.canonicalRead.cleanBodySha256);
        }
        if (part.outputSha256) {
          validDigests.add(part.outputSha256);
        }
        if (part.subagent) {
          walk(part.subagent.node);
        }
      }
    }
  };
  walk(ir.root);

  for (const block of verifiedBlocks) {
    if (!validDigests.has(block.actualSha256)) {
      throw new Error(
        `Reconstructed ${block.kind} block produced unknown SHA-256 ${block.actualSha256}`,
      );
    }
  }

  return { verifiedBlocks };
}
