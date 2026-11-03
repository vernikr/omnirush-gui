import type {
  AssistantMessage,
  Message,
  Part,
  Session,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk/v2/client";

export type ExportableSessionMessage = {
  info: Message;
  parts: Part[];
};

export type ExportableSessionTree = {
  session: Session;
  messages: ExportableSessionMessage[];
  todos?: Todo[];
  /** Child sub-agent sessions keyed by their OpenCode session ID (`task` tool `state.metadata.sessionId`). */
  subagentSessions?: ReadonlyMap<string, ExportableSessionTree>;
};

export type ParsedExportSlashCommand = {
  /** Optional relative path inside the workspace (`/export notes/chat.md`), or `null` for direct Downloads export. */
  filename: string | null;
};

export type RelativeExportPathValidation =
  | { ok: true; relativePath: string }
  | { ok: false; reason: string };

/**
 * Deterministic compression profiles:
 * - `"off"`: raw formatted transcript without deduplication or compaction
 * - `"lossless"`: strictly reversible deduplication, range containment, post-edit file deltas, Read prefix stripping, compact small JSON inputs, and lossless TOON tables
 * - `"smart"`: Stage 2 CLI/log noise reduction layered on top of `"lossless"`
 * - `"stubs"`: Stage 2 compact stubs for superseded intermediate reads layered on top of `"smart"`
 */
export type CompressionMode = "off" | "lossless" | "smart" | "stubs";

export type ExportMarkdownOptions = {
  includeToolCalls: boolean;
  includeReasoning: boolean;
  compression: CompressionMode;
};

/**
 * Default options for the interactive Export Markdown dialog (all three
 * checkboxes enabled, lossless compression selected).
 */
export const DEFAULT_EXPORT_MARKDOWN_OPTIONS: Readonly<ExportMarkdownOptions> = {
  includeToolCalls: true,
  includeReasoning: true,
  compression: "lossless",
};

/**
 * Default options when `formatSessionAsMarkdown(tree)` is called programmatically
 * without explicit options (preserves raw uncompressed output compatibility).
 */
export const RAW_EXPORT_MARKDOWN_OPTIONS: Readonly<ExportMarkdownOptions> = {
  includeToolCalls: true,
  includeReasoning: true,
  compression: "off",
};

export type ReadFooterKind = "none" | "eof" | "partial" | "capped_50kb" | "more_lines";

export type CanonicalReadFile = {
  envelopeVersion: "v1" | "v2";
  /** Display file path (from `<path>` tag or tool input). */
  displayPath: string;
  /** Workspace-normalized path key for matching re-reads across turns. */
  comparablePath: string;
  /** Syntax-highlighting fence language inferred from file extension (`"ts"`, `"py"`, `""`, etc.). */
  fenceLanguage: string;
  /** Stripped file lines without `00001| ` or `1: ` prefixes. */
  lines: string[];
  /** Joined `lines.join("\n")`. */
  cleanBody: string;
  /** Full 64-hex SHA-256 of `cleanBody`. */
  cleanBodySha256: string;
  firstLine: number;
  lastLine: number;
  totalLines?: number;
  truncated: boolean;
  footerKind: ReadFooterKind;
};

export type CanonicalToolPartIR = {
  kind: "tool";
  /** Deterministic document-order call ID (`"c001"`, `"c002"`, ...). */
  callRefId: string;
  /** Human-readable turn locator (`"Turn 1"`, `"Turn 2.1"`, ...). */
  turnLabel: string;
  part: ToolPart;
  displayName: string;
  stateTitle: string;
  statusSuffix: string;
  hasInput: boolean;
  prettyInputJson: string | null;
  compactInputJson: string | null;
  pendingRawInput: string | null;
  /** Normalized (`\n`, `trimEnd()`) completed/live output text when present. */
  normalizedOutput: string | null;
  outputSha256: string | null;
  outputBytes: number;
  outputLineCount: number;
  /** Parsed JSON value when `normalizedOutput` is valid JSON object/array. */
  parsedOutputJson: unknown | undefined;
  prettyOutputJson: string | null;
  /** Parsed OpenCode Read file envelope when strictly matched. */
  canonicalRead: CanonicalReadFile | null;
  errorText: string | null;
  attachmentLabels: string[];
  /** Nested sub-agent session node when this `task` call spawned a child session. */
  subagent: CanonicalSubagentIR | null;
};

export type CanonicalSubagentIR = {
  label: string;
  headingDepth: number;
  node: CanonicalSessionNodeIR;
};

export type CanonicalMessagePartIR =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "attachments"; labels: string[] }
  | CanonicalToolPartIR
  | { kind: "subtask"; agent: string; description: string; prompt: string | null }
  | { kind: "patch"; files: string[] }
  | { kind: "agent"; name: string }
  | { kind: "retry"; attempt: number; formattedError: string | null }
  | { kind: "compaction"; auto: boolean };

export type CanonicalMessageIR = {
  info: Message;
  turnLabel: string;
  parts: CanonicalMessagePartIR[];
  assistantError: AssistantMessage["error"] | undefined;
  formattedAssistantError: string | null;
};

export type CanonicalSessionNodeIR = {
  session: Session;
  headingDepth: number;
  messages: CanonicalMessageIR[];
};

export type CanonicalTranscriptIR = {
  root: CanonicalSessionNodeIR;
  todos: Todo[];
  models: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCost: number;
  /** Cached UTF-8 byte count of the full uncompressed transcript (`includeToolCalls: true, includeReasoning: true, compression: "off"`). */
  baselineBytes: number;
};

export type SafetyBypassReason =
  | "tool_error_status"
  | "nonzero_exit_code"
  | "stack_trace_or_exception"
  | "compiler_diagnostic_error"
  | "credentials_or_pem"
  | "sql_migration"
  | "mutating_tool";

export type ToolSafetyDecision = {
  /** When true, lossy Smart truncation/grouping and Stubs mode must not drop lines from this tool call. */
  bypassLossy: boolean;
  /** True when the tool mutates workspace or todo state. */
  isMutatingTool: boolean;
  reasons: SafetyBypassReason[];
};

export type CompressionStats = {
  exactDedupCount: number;
  rangeRefCount: number;
  deltaCount: number;
  canonicalReadCount: number;
  compactJsonCount: number;
  toonTableCount: number;
  smartCompactedCount: number;
  stubbedCount: number;
  safetyBypassCount: number;
  anchorCount: number;
  savedBytesByDedup: number;
  savedBytesByRange: number;
  savedBytesByDelta: number;
  savedBytesByStructured: number;
  savedBytesBySmart: number;
  savedBytesByStubs: number;
};

export type ExportRenderResult = {
  markdown: string;
  utf8Bytes: number;
  baselineBytes: number;
  savedBytes: number;
  savedRatio: number;
  estimatedTokens: number;
  stats: CompressionStats;
};

export type ExpandedLosslessBlock = {
  kind: "source" | "exact_ref" | "range_ref" | "delta_ref" | "toon_table";
  anchorId?: string;
  targetAnchorId?: string;
  expectedSha256Prefix?: string;
  reconstructedText: string;
  actualSha256: string;
};
