import type {
  AssistantMessage,
  FilePart,
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
  /** Optional relative path inside the workspace (`/export notes/chat.md`), or `null` for interactive save/download. */
  filename: string | null;
};

export type RelativeExportPathValidation =
  | { ok: true; relativePath: string }
  | { ok: false; reason: string };

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

const MAX_SLUG_UTF8_BYTES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Compute a backtick code fence guaranteed to be strictly longer than any
 * contiguous run of backticks inside `content`, preventing Markdown injection
 * or broken code blocks even when exporting conversations containing Markdown.
 */
export function fenceMarkdownCode(content: string, language = ""): string {
  const normalized = normalizeNewlines(content);
  let longestRun = 0;
  let currentRun = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized.charCodeAt(i) === 96 /* ` */) {
      currentRun += 1;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const safeLang = language.replace(/`/g, "").trim();
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return `${fence}${safeLang}\n${body}\n${fence}`;
}

function renderBlockquote(headerLine: string | null, text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  const quoted = lines.map((line) => (line.length > 0 ? `> ${line}` : ">"));
  if (headerLine) {
    return [`> ${headerLine}`, ...quoted].join("\n");
  }
  return quoted.join("\n");
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, current: unknown) => {
        if (typeof current === "bigint") return current.toString();
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }
        return current;
      },
      2,
    );
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function formatToolOutputBlock(rawOutput: string): string {
  const normalized = normalizeNewlines(rawOutput).trimEnd();
  if (!normalized) return fenceMarkdownCode("(empty output)");
  const trimmed = normalized.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        return fenceMarkdownCode(safeJsonStringify(parsed), "json");
      }
    } catch {
      // Not valid JSON; render raw text below.
    }
  }
  return fenceMarkdownCode(normalized);
}

function hasMeaningfulInput(input: Record<string, unknown>): boolean {
  return Object.keys(input).length > 0;
}

function humanizeToolName(rawTool: string): string {
  const trimmed = rawTool.trim();
  if (!trimmed) return "Tool";
  const lower = trimmed.toLowerCase();
  const builtin = BUILTIN_TOOL_TITLES[lower];
  if (builtin) return builtin;
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function extractChildSessionId(metadata: Record<string, unknown> | undefined): string | null {
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

function extractSyntheticAttachmentNames(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const raw = metadata.omnirushAttachments;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name) names.push(name);
  }
  return names;
}

function formatFileAttachmentLabel(part: FilePart): string {
  const sourcePath =
    part.source && (part.source.type === "file" || part.source.type === "symbol")
      ? part.source.path.trim()
      : part.source && part.source.type === "resource"
        ? part.source.uri.trim()
        : "";
  const primary = part.filename?.trim() || sourcePath || (part.url.startsWith("data:") ? "inline-attachment" : part.url);
  const mime = part.mime?.trim();
  return mime ? `${primary} (${mime})` : primary;
}

function formatAssistantError(error: AssistantMessage["error"]): string | null {
  if (!error) return null;
  const dataRecord: Record<string, unknown> | null = isRecord(error.data) ? error.data : null;
  const detail =
    dataRecord && typeof dataRecord.message === "string" && dataRecord.message.trim()
      ? dataRecord.message.trim()
      : error.name;
  if (detail === error.name) {
    return `> **Error:** ${error.name}`;
  }
  return `> **Error (${error.name}):** ${normalizeNewlines(detail).replace(/\n+/g, " ")}`;
}

function headingHashes(depth: number): string {
  const clamped = Math.min(6, Math.max(1, depth));
  return "#".repeat(clamped);
}

function formatIsoTimestamp(epochMs: number | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  try {
    return new Date(epochMs).toISOString().replace(".000Z", "Z");
  } catch {
    return null;
  }
}

function renderSubagentBlock(
  part: ToolPart,
  childTree: ExportableSessionTree,
  headingDepth: number,
  visited: ReadonlySet<string>,
): string | null {
  if (visited.has(childTree.session.id)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(childTree.session.id);

  const input = part.state.input;
  const subagentType = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : part.state.status === "completed" || part.state.status === "running"
        ? (part.state.title?.trim() ?? "")
        : "";
  const titleFallback = childTree.session.title?.trim() || childTree.session.id;
  const baseLabel = description || titleFallback;
  const label = subagentType ? `${baseLabel} (${subagentType})` : baseLabel;

  const subHeading = headingHashes(headingDepth);
  const innerBody = renderMessagesSection(
    childTree,
    Math.min(6, headingDepth + 1),
    nextVisited,
  );
  if (!innerBody) {
    return `${subHeading} ⤷ Subagent: ${label}\n\n_(no recorded subagent turns)_\n\n${subHeading} ⤶ End subagent`;
  }
  return `${subHeading} ⤷ Subagent: ${label}\n\n${innerBody}\n\n${subHeading} ⤶ End subagent`;
}

function renderToolPart(
  part: ToolPart,
  tree: ExportableSessionTree,
  headingDepth: number,
  visited: ReadonlySet<string>,
): string {
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

  const header = `**🛠 ${displayName}**${stateTitle}${statusSuffix}`;
  const blocks: string[] = [];

  if (hasMeaningfulInput(state.input)) {
    blocks.push(fenceMarkdownCode(safeJsonStringify(state.input), "json"));
  } else if (state.status === "pending" && state.raw.trim()) {
    blocks.push(fenceMarkdownCode(state.raw));
  }

  if (state.status === "completed") {
    if (state.output.trim()) {
      blocks.push(formatToolOutputBlock(state.output));
    }
    if (state.attachments && state.attachments.length > 0) {
      const labels = state.attachments.map(formatFileAttachmentLabel);
      blocks.push(`> Tool attachments: ${labels.join(", ")}`);
    }
  } else if (state.status === "error") {
    const liveOutput = extractLiveMetadataOutput(state.metadata);
    if (liveOutput) {
      blocks.push(formatToolOutputBlock(liveOutput));
    }
    const errText = state.error.trim() || "Tool execution failed";
    blocks.push(`_Error:_\n${fenceMarkdownCode(errText)}`);
  } else if (state.status === "running") {
    const liveOutput = extractLiveMetadataOutput(state.metadata);
    if (liveOutput) {
      blocks.push(formatToolOutputBlock(liveOutput));
    }
  }

  const toolSection =
    blocks.length === 0
      ? `${header} _(no input or output)_`
      : `${header}\n\n${blocks.join("\n\n")}`;

  const metadata =
    state.status === "completed" || state.status === "running" || state.status === "error"
      ? state.metadata
      : undefined;
  const childSessionId = extractChildSessionId(metadata);
  const childTree =
    childSessionId && tree.subagentSessions ? tree.subagentSessions.get(childSessionId) : undefined;
  if (!childTree) {
    return toolSection;
  }

  const subagentBlock = renderSubagentBlock(
    part,
    childTree,
    Math.min(6, headingDepth + 1),
    visited,
  );
  return subagentBlock ? `${toolSection}\n\n${subagentBlock}` : toolSection;
}

function renderMessageParts(
  message: ExportableSessionMessage,
  tree: ExportableSessionTree,
  headingDepth: number,
  visited: ReadonlySet<string>,
): string[] {
  const blocks: string[] = [];
  const attachedFiles: string[] = [];

  const flushAttachments = () => {
    if (attachedFiles.length === 0) return;
    blocks.push(`> Attached files: ${attachedFiles.join(", ")}`);
    attachedFiles.length = 0;
  };

  for (const part of message.parts) {
    switch (part.type) {
      case "reasoning": {
        const trimmed = normalizeNewlines(part.text).trim();
        if (!trimmed) break;
        flushAttachments();
        blocks.push(renderBlockquote("_Reasoning_", trimmed));
        break;
      }
      case "text": {
        if (part.ignored) break;
        if (part.synthetic) {
          const syntheticAttachments = extractSyntheticAttachmentNames(part.metadata);
          if (syntheticAttachments.length > 0) {
            attachedFiles.push(...syntheticAttachments);
          }
          break;
        }
        const normalized = normalizeNewlines(part.text).trim();
        if (!normalized) break;
        flushAttachments();
        blocks.push(normalized);
        break;
      }
      case "file": {
        attachedFiles.push(formatFileAttachmentLabel(part));
        break;
      }
      case "tool": {
        flushAttachments();
        blocks.push(renderToolPart(part, tree, headingDepth, visited));
        break;
      }
      case "subtask": {
        flushAttachments();
        const desc = part.description.trim() || part.prompt.trim();
        const subtaskHeader = `**Subtask (\`${part.agent}\`):** ${desc}`;
        if (part.prompt.trim() && part.prompt.trim() !== desc) {
          blocks.push(`${subtaskHeader}\n\n${renderBlockquote(null, part.prompt.trim())}`);
        } else {
          blocks.push(subtaskHeader);
        }
        break;
      }
      case "patch": {
        if (part.files.length > 0) {
          flushAttachments();
          blocks.push(`> Patched files: ${part.files.map((file) => `\`${file}\``).join(", ")}`);
        }
        break;
      }
      case "agent": {
        if (part.name.trim()) {
          flushAttachments();
          blocks.push(`> Agent: \`@${part.name.trim()}\``);
        }
        break;
      }
      case "retry": {
        flushAttachments();
        const retryMsg = formatAssistantError(part.error) ?? `> _Retry attempt ${part.attempt}_`;
        blocks.push(`> _Retry attempt ${part.attempt}_\n${retryMsg}`);
        break;
      }
      case "compaction": {
        flushAttachments();
        blocks.push(part.auto ? "> _Context compacted automatically_" : "> _Context compacted_");
        break;
      }
      case "step-start":
      case "step-finish":
      case "snapshot":
        break;
    }
  }

  flushAttachments();

  if (message.info.role === "assistant" && message.info.error) {
    const formattedError = formatAssistantError(message.info.error);
    if (formattedError) blocks.push(formattedError);
  }

  return blocks;
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

function renderMessagesSection(
  tree: ExportableSessionTree,
  headingDepth: number,
  visited: ReadonlySet<string>,
): string {
  const visible = filterVisibleBranchMessages(tree.session, tree.messages);
  const turnHeading = headingHashes(headingDepth);
  const renderedTurns: string[] = [];

  for (const message of visible) {
    const blocks = renderMessageParts(message, tree, headingDepth, visited);
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

  return renderedTurns.join("\n\n---\n\n");
}

function renderTodosSection(todos: ReadonlyArray<Todo> | undefined): string | null {
  if (!todos || todos.length === 0) return null;
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

/**
 * Format a full OmniRush chat session/branch (including model reasoning,
 * tool calls with JSON inputs & outputs, errors, attachments, todos, and
 * nested sub-agent sessions) as a standalone Markdown document.
 */
export function formatSessionAsMarkdown(tree: ExportableSessionTree): string {
  const visible = filterVisibleBranchMessages(tree.session, tree.messages);
  const visited = new Set<string>([tree.session.id]);
  const body = renderMessagesSection(tree, 2, visited);

  const rawTitle = tree.session.title?.trim() ?? "";
  const title = rawTitle ? normalizeNewlines(rawTitle).replace(/\n+/g, " ") : "OmniRush conversation";

  const models = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCost = 0;
  let renderedTurnCount = 0;

  for (const message of visible) {
    const hasContent =
      message.parts.some((part) => {
        if (part.type === "text") return !part.ignored && (!part.synthetic || extractSyntheticAttachmentNames(part.metadata).length > 0) && Boolean(part.text.trim() || part.synthetic);
        if (part.type === "reasoning") return Boolean(part.text.trim());
        return (
          part.type === "tool" ||
          part.type === "file" ||
          part.type === "subtask" ||
          part.type === "patch" ||
          part.type === "agent" ||
          part.type === "retry" ||
          part.type === "compaction"
        );
      }) || Boolean(message.info.role === "assistant" && message.info.error);
    if (hasContent) renderedTurnCount += 1;

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

  const countLabel = `${renderedTurnCount} ${renderedTurnCount === 1 ? "message" : "messages"}`;
  const metadataBullets: string[] = [];
  if (tree.session.directory?.trim()) {
    metadataBullets.push(`- **Workspace:** \`${tree.session.directory.trim()}\``);
  }
  if (tree.session.parentID?.trim()) {
    metadataBullets.push(`- **Parent session:** \`${tree.session.parentID.trim()}\``);
  }
  const createdIso = formatIsoTimestamp(tree.session.time?.created);
  const updatedIso = formatIsoTimestamp(tree.session.time?.updated);
  if (createdIso && updatedIso && createdIso !== updatedIso) {
    metadataBullets.push(`- **Created:** ${createdIso} · **Updated:** ${updatedIso}`);
  } else if (createdIso) {
    metadataBullets.push(`- **Created:** ${createdIso}`);
  }
  if (models.size > 0) {
    metadataBullets.push(`- **Models:** ${[...models].map((m) => `\`${m}\``).join(", ")}`);
  }
  if (totalInputTokens > 0 || totalOutputTokens > 0 || totalReasoningTokens > 0) {
    const tokenParts = [`${totalInputTokens.toLocaleString("en-US")} input`, `${totalOutputTokens.toLocaleString("en-US")} output`];
    if (totalReasoningTokens > 0) {
      tokenParts.push(`${totalReasoningTokens.toLocaleString("en-US")} reasoning`);
    }
    const costSuffix = totalCost > 0 ? ` ($${totalCost.toFixed(4)})` : "";
    metadataBullets.push(`- **Tokens:** ${tokenParts.join(", ")}${costSuffix}`);
  }

  const headerLines = [
    `# ${title}`,
    `_${countLabel} · Session \`${tree.session.id}\`_`,
  ];
  if (metadataBullets.length > 0) {
    headerLines.push("", ...metadataBullets);
  }

  const sections = [headerLines.join("\n")];
  if (body) {
    sections.push(body);
  } else {
    sections.push("_(no messages in this branch)_");
  }

  const todosSection = renderTodosSection(tree.todos);
  if (todosSection) {
    sections.push(todosSection);
  }

  return `${sections.join("\n\n---\n\n")}\n`;
}

function truncateUtf8ByCodePoint(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).byteLength <= maxBytes) return input;
  let result = "";
  let usedBytes = 0;
  for (const ch of input) {
    const chunkBytes = encoder.encode(ch).byteLength;
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
