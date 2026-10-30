import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  extractChildSessionId,
  filterVisibleBranchMessages,
  inferFenceLanguageFromPath,
  normalizeComparableFilePath,
  parseCanonicalReadEnvelope,
} from "./markdown-export/canonicalize";
import { applyLosslessFileDelta, computeLosslessFileDelta } from "./markdown-export/file-delta";
import { sha256Hex, shortSha256, utf8ByteLength } from "./markdown-export/hash-and-bytes";
import { expandLosslessMarkdown, verifyLosslessRoundTrip } from "./markdown-export/lossless-expander";
import { buildCanonicalTranscriptIR, renderTranscriptFromIR } from "./markdown-export/render-markdown";
import { classifyToolSafety } from "./markdown-export/safety-router";
import {
  applySmartCliTransform,
  buildBranchStubIndex,
  collapsePassingTestRuns,
  compactSearchOutput,
  stripAnsiAndProgressNoise,
  tryBuildCompactStub,
} from "./markdown-export/smart-cli";
import {
  decodeLosslessToon,
  fenceMarkdownCode,
  tryEncodeLosslessToon,
  tryFormatCompactJsonInput,
} from "./markdown-export/structured-compact";
import {
  DEFAULT_EXPORT_MARKDOWN_OPTIONS,
  RAW_EXPORT_MARKDOWN_OPTIONS,
  type CanonicalMessageIR,
  type CanonicalMessagePartIR,
  type CanonicalReadFile,
  type CanonicalSessionNodeIR,
  type CanonicalSubagentIR,
  type CanonicalToolPartIR,
  type CanonicalTranscriptIR,
  type CompressionMode,
  type CompressionStats,
  type ExpandedLosslessBlock,
  type ExportableSessionMessage,
  type ExportableSessionTree,
  type ExportMarkdownOptions,
  type ExportRenderResult,
  type ParsedExportSlashCommand,
  type ReadFooterKind,
  type RelativeExportPathValidation,
  type SafetyBypassReason,
  type ToolSafetyDecision,
} from "./markdown-export/types";

export {
  applyLosslessFileDelta,
  applySmartCliTransform,
  buildBranchStubIndex,
  buildCanonicalTranscriptIR,
  classifyToolSafety,
  collapsePassingTestRuns,
  compactSearchOutput,
  computeLosslessFileDelta,
  decodeLosslessToon,
  DEFAULT_EXPORT_MARKDOWN_OPTIONS,
  expandLosslessMarkdown,
  fenceMarkdownCode,
  filterVisibleBranchMessages,
  inferFenceLanguageFromPath,
  normalizeComparableFilePath,
  parseCanonicalReadEnvelope,
  RAW_EXPORT_MARKDOWN_OPTIONS,
  renderTranscriptFromIR,
  sha256Hex,
  shortSha256,
  stripAnsiAndProgressNoise,
  tryBuildCompactStub,
  tryEncodeLosslessToon,
  tryFormatCompactJsonInput,
  utf8ByteLength,
  verifyLosslessRoundTrip,
};

export type {
  CanonicalMessageIR,
  CanonicalMessagePartIR,
  CanonicalReadFile,
  CanonicalSessionNodeIR,
  CanonicalSubagentIR,
  CanonicalToolPartIR,
  CanonicalTranscriptIR,
  CompressionMode,
  CompressionStats,
  ExpandedLosslessBlock,
  ExportableSessionMessage,
  ExportableSessionTree,
  ExportMarkdownOptions,
  ExportRenderResult,
  ParsedExportSlashCommand,
  ReadFooterKind,
  RelativeExportPathValidation,
  SafetyBypassReason,
  ToolSafetyDecision,
};

const MAX_SLUG_UTF8_BYTES = 64;

/**
 * Format a full OmniRush chat session/branch (including model reasoning,
 * tool calls with JSON inputs & outputs, errors, attachments, todos, and
 * nested sub-agent sessions) as a standalone Markdown document.
 *
 * When `options` is omitted, renders the raw uncompressed transcript for
 * backward compatibility; pass `{ compression: "lossless" }` (or
 * `DEFAULT_EXPORT_MARKDOWN_OPTIONS`) to run the deterministic lossless pipeline.
 */
export function formatSessionAsMarkdown(
  tree: ExportableSessionTree,
  options?: Partial<ExportMarkdownOptions>,
): string {
  const ir = buildCanonicalTranscriptIR(tree);
  return renderTranscriptFromIR(ir, options).markdown;
}

function truncateUtf8ByCodePoint(input: string, maxBytes: number): string {
  if (utf8ByteLength(input) <= maxBytes) return input;
  let result = "";
  let usedBytes = 0;
  for (const ch of input) {
    const chunkBytes = utf8ByteLength(ch);
    if (usedBytes + chunkBytes > maxBytes) break;
    result += ch;
    usedBytes += chunkBytes;
  }
  return result.replace(/[-_.]+$/g, "");
}

function sanitizeFilenameSlug(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return truncateUtf8ByCodePoint(cleaned, MAX_SLUG_UTF8_BYTES);
}

/**
 * Build a safe default `.md` filename for saving a session transcript across
 * macOS, Windows, and Linux without hitting 255-byte path component limits.
 */
export function buildSessionExportFilename(
  session: Pick<Session, "id" | "title">,
): string {
  const safeId = session.id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "session";
  const rawTitle = session.title?.trim() ?? "";
  const titleSlug = rawTitle ? sanitizeFilenameSlug(rawTitle) : "";
  if (!titleSlug) {
    return `omnirush-chat-${safeId}.md`;
  }
  const shortId = safeId.slice(-10);
  return `${titleSlug}-${shortId}.md`;
}

function ensureMarkdownExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return filePath;
  }
  return `${filePath}.md`;
}

/**
 * Parse a client-side `/export` or `/export <filename>` composer command.
 * Returns `null` when the text is not an `/export` command.
 */
export function parseExportSlashCommand(text: string): ParsedExportSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^\/export(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (!match) return null;
  const rawArg = (match[1] ?? "").trim();
  if (!rawArg) return { filename: null };
  if (rawArg.includes("\n") || rawArg.includes("\r")) return null;

  const unquoted =
    (rawArg.startsWith('"') && rawArg.endsWith('"') && rawArg.length >= 2) ||
    (rawArg.startsWith("'") && rawArg.endsWith("'") && rawArg.length >= 2)
      ? rawArg.slice(1, -1).trim()
      : rawArg;
  if (!unquoted) return { filename: null };
  return { filename: ensureMarkdownExtension(unquoted) };
}

/**
 * Validate a relative filename passed to `/export <filename>` before writing
 * inside a local or remote workspace.
 */
export function validateRelativeExportPath(rawPath: string): RelativeExportPathValidation {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return { ok: false, reason: "Invalid export filename" };
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    return { ok: false, reason: "Refusing to write outside the project folder" };
  }
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    return { ok: false, reason: "Export path must name a file, not a directory" };
  }
  const segments = trimmed.split(/[\\/]+/);
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      return { ok: false, reason: "Refusing to write outside the project folder" };
    }
    if (/[<>:"|?*\u0000-\u001F]/.test(segment)) {
      return { ok: false, reason: "Export filename contains unsupported characters" };
    }
  }
  const normalizedRel = ensureMarkdownExtension(segments.join("/"));
  return { ok: true, relativePath: normalizedRel };
}

/**
 * Collect referenced sub-agent session IDs from `task` tool calls in the
 * visible branch of a session.
 */
export function collectReferencedSubagentSessionIds(
  session: Pick<Session, "revert">,
  messages: ReadonlyArray<ExportableSessionMessage>,
): string[] {
  const visible = filterVisibleBranchMessages(session, messages);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const message of visible) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const state = part.state;
      const metadata =
        state.status === "completed" || state.status === "running" || state.status === "error"
          ? state.metadata
          : undefined;
      const childId = extractChildSessionId(metadata);
      if (childId && !seen.has(childId)) {
        seen.add(childId);
        found.push(childId);
      }
    }
  }
  return found;
}
