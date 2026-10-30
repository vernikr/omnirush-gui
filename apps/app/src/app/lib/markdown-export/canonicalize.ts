import type {
  AssistantMessage,
  FilePart,
  Part,
  Session,
  ToolPart,
} from "@opencode-ai/sdk/v2/client";

import { sha256Hex, utf8ByteLength } from "./hash-and-bytes";
import {
  isPlainObject,
  normalizeNewlines,
  safeJsonStringify,
  tryFormatCompactJsonInput,
} from "./structured-compact";
import type {
  CanonicalMessageIR,
  CanonicalMessagePartIR,
  CanonicalReadFile,
  CanonicalSessionNodeIR,
  CanonicalSubagentIR,
  CanonicalTranscriptIR,
  ExportableSessionMessage,
  ExportableSessionTree,
  ReadFooterKind,
} from "./types";

const BUILTIN_TOOL_TITLES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  apply_patch: "Apply Patch",
  patch: "Patch",
  glob: "Glob",
  grep: "Grep",
  list: "List",
  ls: "List",
  task: "Task",
  todowrite: "Todo Write",
  todoread: "Todo Read",
  webfetch: "Web Fetch",
  websearch: "Web Search",
  codesearch: "Code Search",
  question: "Question",
  skill: "Skill",
  lsp: "LSP",
  batch: "Batch",
  plan_enter: "Enter Plan Mode",
  plan_exit: "Exit Plan Mode",
  structuredoutput: "Structured Output",
};

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
};

const END_OF_FILE_PATTERN = /^\(End of file - total (\d+) lines\)$/;
const OUTPUT_CAPPED_PATTERN =
  /^\(Output capped at 50 KB\. Showing lines (\d+)-(\d+)\. Use offset=(\d+) to continue\.\)$/;
const PARTIAL_FILE_PATTERN =
  /^\(Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\)$/;
const MORE_LINES_V1_PATTERN =
  /^\(File has more lines\. Use 'offset' parameter to read beyond line (\d+)\)$/;

const V2_LINE_PATTERN = /^(\d+): ?(.*)$/;
const V1_LINE_PATTERN = /^0*(\d+)\| ?(.*)$/;

export function humanizeToolName(rawTool: string): string {
  const trimmed = rawTool.trim();
  if (!trimmed) return "Tool";
  const lower = trimmed.toLowerCase();
  const builtin = BUILTIN_TOOL_TITLES[lower];
  if (builtin) return builtin;
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

export function inferFenceLanguageFromPath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  const leaf = normalized.split("/").pop() ?? "";
  if (!leaf) return "";
  const lowerLeaf = leaf.toLowerCase();
  if (lowerLeaf === "dockerfile" || lowerLeaf.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  const dotIdx = lowerLeaf.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === lowerLeaf.length - 1) return "";
  const ext = lowerLeaf.slice(dotIdx + 1);
  return EXTENSION_LANGUAGE_MAP[ext] ?? "";
}

export function normalizeComparableFilePath(rawPath: string, workspaceRoot?: string): string {
  let cleaned = rawPath.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!cleaned) return "";
  const root = (workspaceRoot ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && cleaned.startsWith(`${root}/`)) {
    cleaned = cleaned.slice(root.length + 1);
  }
  if (cleaned.startsWith("./")) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

function extractInputFilePath(input: Record<string, unknown>): string {
  for (const key of ["filePath", "file_path", "path"]) {
    const val = input[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

function parseNumberedBody(
  body: string,
  linePattern: RegExp,
): {
  lines: string[];
  firstLine: number;
  lastLine: number;
  totalLines?: number;
  truncated: boolean;
  footerKind: ReadFooterKind;
} | null {
  const rawLines = normalizeNewlines(body).split("\n");
  // Trim single leading/trailing structural newline inside XML tag
  if (rawLines[0] === "") rawLines.shift();
  if (rawLines.at(-1) === "") rawLines.pop();

  const parsedLines: Array<{ num: number; text: string }> = [];
  let inFooterZone = false;
  let footerKind: ReadFooterKind = "none";
  let totalLines: number | undefined;
  let truncated = false;

  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i]!;
    if (!inFooterZone) {
      const m = linePattern.exec(rawLine);
      if (m) {
        const num = Number(m[1]);
        if (!Number.isInteger(num) || num < 1) return null;
        if (parsedLines.length > 0 && num !== parsedLines[parsedLines.length - 1]!.num + 1) {
          return null;
        }
        parsedLines.push({ num, text: m[2] ?? "" });
        continue;
      }
      inFooterZone = true;
    }

    if (rawLine === "") {
      continue;
    }

    // Only one footer marker is valid in a canonical OpenCode Read envelope
    if (footerKind !== "none") {
      return null;
    }

    const eofMatch = END_OF_FILE_PATTERN.exec(rawLine);
    if (eofMatch) {
      footerKind = "eof";
      totalLines = Number(eofMatch[1]);
      continue;
    }

    const partialMatch = PARTIAL_FILE_PATTERN.exec(rawLine);
    if (partialMatch) {
      footerKind = "partial";
      totalLines = Number(partialMatch[3]);
      truncated = true;
      continue;
    }

    const cappedMatch = OUTPUT_CAPPED_PATTERN.exec(rawLine);
    if (cappedMatch) {
      footerKind = "capped_50kb";
      truncated = true;
      continue;
    }

    const moreV1Match = MORE_LINES_V1_PATTERN.exec(rawLine);
    if (moreV1Match) {
      footerKind = "more_lines";
      truncated = true;
      continue;
    }

    return null;
  }

  if (parsedLines.length === 0) {
    if (footerKind === "eof" && totalLines === 0) {
      return {
        lines: [],
        firstLine: 0,
        lastLine: 0,
        totalLines: 0,
        truncated: false,
        footerKind,
      };
    }
    return null;
  }

  return {
    lines: parsedLines.map((entry) => entry.text),
    firstLine: parsedLines[0]!.num,
    lastLine: parsedLines[parsedLines.length - 1]!.num,
    totalLines,
    truncated,
    footerKind,
  };
}

/**
 * Strictly parse OpenCode v1 (`<file>\n00001| ...`) and v2
 * (`<path>...</path>\n<type>file</type>\n<content>\n1: ...`) `read` envelopes.
 * Returns `null` on directory listings or any non-standard output so unknown
 * formats always fall back untouched.
 */
export function parseCanonicalReadEnvelope(params: {
  toolName: string;
  rawOutput: string;
  input: Record<string, unknown>;
  workspaceRoot?: string;
}): CanonicalReadFile | null {
  const { toolName, rawOutput, input, workspaceRoot } = params;
  if (toolName.trim().toLowerCase() !== "read") return null;
  const normalized = normalizeNewlines(rawOutput).trim();
  if (!normalized) return null;

  // Variant A: OpenCode v2 `<path>...</path>\n<type>file</type>\n<content>...</content>`
  const v2Match =
    /^(?:<path>([\s\S]*?)<\/path>\s*)?<type>file<\/type>\s*<content>([\s\S]*?)<\/content>$/.exec(
      normalized,
    );
  if (v2Match) {
    const tagPath = (v2Match[1] ?? "").trim();
    const displayPath = tagPath || extractInputFilePath(input);
    const bodyResult = parseNumberedBody(v2Match[2] ?? "", V2_LINE_PATTERN);
    if (!bodyResult) return null;
    const cleanBody = bodyResult.lines.join("\n");
    return {
      envelopeVersion: "v2",
      displayPath,
      comparablePath: normalizeComparableFilePath(displayPath, workspaceRoot),
      fenceLanguage: inferFenceLanguageFromPath(displayPath),
      lines: bodyResult.lines,
      cleanBody,
      cleanBodySha256: sha256Hex(cleanBody),
      firstLine: bodyResult.firstLine,
      lastLine: bodyResult.lastLine,
      totalLines: bodyResult.totalLines,
      truncated: bodyResult.truncated,
      footerKind: bodyResult.footerKind,
    };
  }

  // Variant B: OpenCode v1 `<file>\n00001| ...\n</file>`
  const v1Match = /^<file>([\s\S]*?)<\/file>$/.exec(normalized);
  if (v1Match) {
    const displayPath = extractInputFilePath(input);
    const bodyResult = parseNumberedBody(v1Match[1] ?? "", V1_LINE_PATTERN);
    if (!bodyResult) return null;
    const cleanBody = bodyResult.lines.join("\n");
    return {
      envelopeVersion: "v1",
      displayPath,
      comparablePath: normalizeComparableFilePath(displayPath, workspaceRoot),
      fenceLanguage: inferFenceLanguageFromPath(displayPath),
      lines: bodyResult.lines,
      cleanBody,
      cleanBodySha256: sha256Hex(cleanBody),
      firstLine: bodyResult.firstLine,
      lastLine: bodyResult.lastLine,
      totalLines: bodyResult.totalLines,
      truncated: bodyResult.truncated,
      footerKind: bodyResult.footerKind,
    };
  }

  return null;
}

export function extractChildSessionId(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const candidate = metadata.sessionId ?? metadata.sessionID;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function extractLiveMetadataOutput(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const output = metadata.output;
  if (typeof output === "string" && output.trim()) {
    return output;
  }
  return null;
}

export function extractSyntheticAttachmentNames(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const raw = metadata.omnirushAttachments;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name) names.push(name);
  }
  return names;
}

export function formatFileAttachmentLabel(part: FilePart): string {
  const sourcePath =
    part.source && (part.source.type === "file" || part.source.type === "symbol")
      ? part.source.path.trim()
      : part.source && part.source.type === "resource"
        ? part.source.uri.trim()
        : "";
  const primary =
    part.filename?.trim() ||
    sourcePath ||
    (part.url.startsWith("data:") ? "inline-attachment" : part.url);
  const mime = part.mime?.trim();
  return mime ? `${primary} (${mime})` : primary;
}

export function formatAssistantError(error: AssistantMessage["error"]): string | null {
  if (!error) return null;
  const dataRecord = isPlainObject(error.data) ? error.data : null;
  const detail =
    dataRecord && typeof dataRecord.message === "string" && dataRecord.message.trim()
      ? dataRecord.message.trim()
      : error.name;
  if (detail === error.name) {
    return `> **Error:** ${error.name}`;
  }
  return `> **Error (${error.name}):** ${normalizeNewlines(detail).replace(/\n+/g, " ")}`;
}

/**
 * Filter messages to the active branch state, excluding turns rewound by Undo
 * (`session.revert.messageID`).
 */
export function filterVisibleBranchMessages(
  session: Pick<Session, "revert">,
  messages: ReadonlyArray<ExportableSessionMessage>,
): ExportableSessionMessage[] {
  const revertId = session.revert?.messageID?.trim() ?? "";
  if (!revertId) return [...messages];
  return messages.filter((message) => message.info.id < revertId);
}

function tryParseJsonObjectOrArray(rawText: string): { parsed: unknown; pretty: string } | null {
  const trimmed = rawText.trim();
  if (
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return { parsed, pretty: safeJsonStringify(parsed, 2) };
    }
  } catch {
    // Not valid JSON.
  }
  return null;
}

function buildSubagentLabel(part: ToolPart, childSession: Session): string {
  const input = part.state.input;
  const subagentType = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : part.state.status === "completed" || part.state.status === "running"
        ? (part.state.title?.trim() ?? "")
        : "";
  const titleFallback = childSession.title?.trim() || childSession.id;
  const baseLabel = description || titleFallback;
  return subagentType ? `${baseLabel} (${subagentType})` : baseLabel;
}

export function buildCanonicalSessionNode(params: {
  tree: ExportableSessionTree;
  rootSubagents: ReadonlyMap<string, ExportableSessionTree> | undefined;
  headingDepth: number;
  turnPrefix: string;
  visited: ReadonlySet<string>;
  nextCallIndex: () => number;
}): CanonicalSessionNodeIR {
  const { tree, rootSubagents, headingDepth, turnPrefix, visited, nextCallIndex } = params;
  const visible = filterVisibleBranchMessages(tree.session, tree.messages);
  const workspaceRoot = tree.session.directory?.trim() ?? "";
  const messages: CanonicalMessageIR[] = [];

  let localTurnNumber = 0;

  for (const message of visible) {
    localTurnNumber += 1;
    const turnLabel = turnPrefix ? `${turnPrefix}.${localTurnNumber}` : `Turn ${localTurnNumber}`;
    const parts: CanonicalMessagePartIR[] = [];
    const pendingAttachments: string[] = [];

    const flushAttachments = () => {
      if (pendingAttachments.length === 0) return;
      parts.push({ kind: "attachments", labels: [...pendingAttachments] });
      pendingAttachments.length = 0;
    };

    for (const part of message.parts) {
      switch (part.type) {
        case "reasoning": {
          const trimmed = normalizeNewlines(part.text).trim();
          if (!trimmed) break;
          flushAttachments();
          parts.push({ kind: "reasoning", text: trimmed });
          break;
        }
        case "text": {
          if (part.ignored) break;
          if (part.synthetic) {
            const syntheticAttachments = extractSyntheticAttachmentNames(part.metadata);
            if (syntheticAttachments.length > 0) {
              pendingAttachments.push(...syntheticAttachments);
            }
            break;
          }
          const normalized = normalizeNewlines(part.text).trim();
          if (!normalized) break;
          flushAttachments();
          parts.push({ kind: "text", text: normalized });
          break;
        }
        case "file": {
          pendingAttachments.push(formatFileAttachmentLabel(part));
          break;
        }
        case "tool": {
          flushAttachments();
          const callNum = nextCallIndex();
          const callRefId = `c${String(callNum).padStart(3, "0")}`;
          const displayName = humanizeToolName(part.tool);
          const state = part.state;
          const codeModeFailed =
            Boolean(part.metadata && part.metadata.omnirushV2CodeMode === true) &&
            state.status === "completed" &&
            Boolean(state.metadata && state.metadata.error === true);

          const statusSuffix =
            state.status === "error" || codeModeFailed
              ? " _(error)_"
              : state.status === "running"
                ? " _(running)_"
                : state.status === "pending"
                  ? " _(pending)_"
                  : "";

          const stateTitle =
            (state.status === "completed" || state.status === "running") && state.title?.trim()
              ? ` — ${state.title.trim()}`
              : "";

          const hasInput = Object.keys(state.input).length > 0;
          const prettyInputJson = hasInput ? safeJsonStringify(state.input, 2) : null;
          const compactInputJson = hasInput ? tryFormatCompactJsonInput(state.input) : null;
          const pendingRawInput =
            !hasInput && state.status === "pending" && state.raw.trim() ? state.raw : null;

          let rawOutputCandidate: string | null = null;
          if (state.status === "completed") {
            if (state.output.trim()) {
              rawOutputCandidate = state.output;
            }
          } else if (state.status === "error" || state.status === "running") {
            rawOutputCandidate = extractLiveMetadataOutput(state.metadata);
          }

          const normalizedOutput =
            rawOutputCandidate !== null ? normalizeNewlines(rawOutputCandidate).trimEnd() : null;
          const nonEmptyOutput =
            normalizedOutput !== null && normalizedOutput.length > 0 ? normalizedOutput : null;

          const parsedJsonResult =
            nonEmptyOutput !== null ? tryParseJsonObjectOrArray(nonEmptyOutput) : null;

          const canonicalRead =
            state.status === "completed" && nonEmptyOutput !== null
              ? parseCanonicalReadEnvelope({
                  toolName: part.tool,
                  rawOutput: nonEmptyOutput,
                  input: state.input,
                  workspaceRoot,
                })
              : null;

          const canonicalHashPayload =
            parsedJsonResult !== null ? parsedJsonResult.pretty : nonEmptyOutput;
          const outputSha256 =
            canonicalHashPayload !== null ? sha256Hex(canonicalHashPayload) : null;
          const outputBytes =
            canonicalHashPayload !== null ? utf8ByteLength(canonicalHashPayload) : 0;
          const outputLineCount =
            canonicalHashPayload !== null ? canonicalHashPayload.split("\n").length : 0;

          const attachmentLabels =
            state.status === "completed" && state.attachments && state.attachments.length > 0
              ? state.attachments.map(formatFileAttachmentLabel)
              : [];

          const errorText =
            state.status === "error" ? state.error.trim() || "Tool execution failed" : null;

          const metadata =
            state.status === "completed" || state.status === "running" || state.status === "error"
              ? state.metadata
              : undefined;
          const childSessionId = extractChildSessionId(metadata);
          const childTree =
            childSessionId
              ? (tree.subagentSessions?.get(childSessionId) ?? rootSubagents?.get(childSessionId))
              : undefined;

          let subagent: CanonicalSubagentIR | null = null;
          if (childTree && !visited.has(childTree.session.id)) {
            const nextVisited = new Set(visited);
            nextVisited.add(childTree.session.id);
            const subHeadingDepth = Math.min(6, headingDepth + 1);
            const childNode = buildCanonicalSessionNode({
              tree: childTree,
              rootSubagents: childTree.subagentSessions ?? rootSubagents,
              headingDepth: Math.min(6, subHeadingDepth + 1),
              turnPrefix: turnLabel,
              visited: nextVisited,
              nextCallIndex,
            });
            subagent = {
              label: buildSubagentLabel(part, childTree.session),
              headingDepth: subHeadingDepth,
              node: childNode,
            };
          }

          parts.push({
            kind: "tool",
            callRefId,
            turnLabel,
            part,
            displayName,
            stateTitle,
            statusSuffix,
            hasInput,
            prettyInputJson,
            compactInputJson,
            pendingRawInput,
            normalizedOutput: nonEmptyOutput,
            outputSha256,
            outputBytes,
            outputLineCount,
            parsedOutputJson: parsedJsonResult ? parsedJsonResult.parsed : undefined,
            prettyOutputJson: parsedJsonResult ? parsedJsonResult.pretty : null,
            canonicalRead,
            errorText,
            attachmentLabels,
            subagent,
          });
          break;
        }
        case "subtask": {
          flushAttachments();
          const desc = part.description.trim() || part.prompt.trim();
          const promptTrimmed = part.prompt.trim();
          parts.push({
            kind: "subtask",
            agent: part.agent,
            description: desc,
            prompt: promptTrimmed && promptTrimmed !== desc ? promptTrimmed : null,
          });
          break;
        }
        case "patch": {
          if (part.files.length > 0) {
            flushAttachments();
            parts.push({ kind: "patch", files: [...part.files] });
          }
          break;
        }
        case "agent": {
          if (part.name.trim()) {
            flushAttachments();
            parts.push({ kind: "agent", name: part.name.trim() });
          }
          break;
        }
        case "retry": {
          flushAttachments();
          parts.push({
            kind: "retry",
            attempt: part.attempt,
            formattedError: formatAssistantError(part.error),
          });
          break;
        }
        case "compaction": {
          flushAttachments();
          parts.push({ kind: "compaction", auto: Boolean(part.auto) });
          break;
        }
        case "step-start":
        case "step-finish":
        case "snapshot":
          break;
      }
    }

    flushAttachments();

    const assistantError = message.info.role === "assistant" ? message.info.error : undefined;
    const formattedAssistantError = assistantError ? formatAssistantError(assistantError) : null;

    if (parts.length === 0 && !formattedAssistantError) {
      localTurnNumber -= 1;
      continue;
    }

    messages.push({
      info: message.info,
      turnLabel,
      parts,
      assistantError,
      formattedAssistantError,
    });
  }

  return {
    session: tree.session,
    headingDepth,
    messages,
  };
}

/**
 * Helper used during canonicalization before baseline bytes are attached.
 */
export function collectRootSessionStats(messages: ReadonlyArray<ExportableSessionMessage>): {
  models: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCost: number;
} {
  const models = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCost = 0;

  for (const message of messages) {
    if (message.info.role === "assistant") {
      const modelId =
        message.info.providerID && message.info.modelID
          ? `${message.info.providerID}/${message.info.modelID}`
          : message.info.modelID;
      if (modelId) models.add(modelId);
      totalInputTokens += message.info.tokens?.input || 0;
      totalOutputTokens += message.info.tokens?.output || 0;
      totalReasoningTokens += message.info.tokens?.reasoning || 0;
      totalCost += message.info.cost || 0;
    }
  }

  return {
    models: [...models],
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalCost,
  };
}

export function createCanonicalTranscriptIRWithoutBaseline(
  tree: ExportableSessionTree,
): Omit<CanonicalTranscriptIR, "baselineBytes"> {
  const visibleRoot = filterVisibleBranchMessages(tree.session, tree.messages);
  const visited = new Set<string>([tree.session.id]);
  let callCounter = 0;
  const root = buildCanonicalSessionNode({
    tree,
    rootSubagents: tree.subagentSessions,
    headingDepth: 2,
    turnPrefix: "",
    visited,
    nextCallIndex: () => {
      callCounter += 1;
      return callCounter;
    },
  });
  const stats = collectRootSessionStats(visibleRoot);

  return {
    root,
    todos: tree.todos ? [...tree.todos] : [],
    models: stats.models,
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalReasoningTokens: stats.totalReasoningTokens,
    totalCost: stats.totalCost,
  };
}
