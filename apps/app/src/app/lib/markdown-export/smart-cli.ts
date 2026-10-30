import { normalizeComparableFilePath } from "./canonicalize";
import { shortSha256, utf8ByteLength } from "./hash-and-bytes";
import { fenceMarkdownCode, isPlainObject } from "./structured-compact";
import type {
  CanonicalReadFile,
  CanonicalSessionNodeIR,
  CanonicalToolPartIR,
  ToolSafetyDecision,
} from "./types";

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const BRAILLE_SPINNER_LINE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s.*)?$/;

const PASSING_TEST_LINE_PATTERNS: readonly RegExp[] = [
  // Bun test: `(pass) suite > test [1.23ms]`
  /^\(pass\)\s+\S.*$/,
  // Vitest / Jest / Mocha: ` ✓ suite > test (5 ms)` or ` ✔ test name`
  /^\s*[✓✔]\s+\S.*$/,
  // Cargo test: `test module::my_test ... ok`
  /^test\s+\S+\s+\.\.\.\s+ok$/,
  // Pytest verbose: `tests/test_api.py::test_login PASSED [ 25%]`
  /^\S+::\S+\s+PASSED(?:\s+\[\s*\d+%\])?$/,
  // Go test verbose: `--- PASS: TestSomething (0.01s)`
  /^---\s+PASS:\s+\S+\s+\([0-9.]+s\)$/,
  // Node test runner single-line TAP/spec without YAML failure block: `ok 1 - my test`
  /^ok\s+\d+\s+-\s+\S.*$/,
];

const MIN_PASSING_RUN_TO_COLLAPSE = 6;
const MIN_IDENTICAL_LOG_RUN = 4;
const CLI_HEAD_TAIL_LINE_THRESHOLD = 110;
const CLI_HEAD_TAIL_BYTE_THRESHOLD = 5500;
const CLI_KEEP_HEAD_LINES = 45;
const CLI_KEEP_TAIL_LINES = 35;
const MIN_SMART_NET_WIN_BYTES = 48;

const MIN_SUPERSEDED_READ_BYTES = 320;
const MIN_SUPERSEDED_READ_LINES = 10;
const MIN_EXPLORATORY_READ_BYTES = 800;
const MIN_EXPLORATORY_READ_LINES = 25;
const MIN_EXPLORATORY_TOOL_BYTES = 1000;
const MIN_EXPLORATORY_TOOL_LINES = 25;
const STUB_PREVIEW_LINES = 4;
const MIN_STUB_NET_WIN_BYTES = 128;

const EXPLORATORY_INSPECTION_TOOLS = new Set([
  "glob",
  "grep",
  "list",
  "ls",
  "codesearch",
  "websearch",
  "webfetch",
]);

/**
 * Strip terminal ANSI CSI/OSC sequences, resolve `\r` progress-bar overwrites
 * on raw lines, and drop standalone braille spinner lines.
 */
export function stripAnsiAndProgressNoise(rawText: string): string {
  const withoutOscAndCsi = rawText.replace(ANSI_ESCAPE_PATTERN, "");
  const rawLines = withoutOscAndCsi.replace(/\r\n/g, "\n").split("\n");
  const cleanedLines: string[] = [];

  for (const rawLine of rawLines) {
    let resolved = rawLine;
    if (resolved.includes("\r")) {
      // Trailing `\r` with nothing after it means the terminal cleared/reset the transient spinner line
      if (resolved.endsWith("\r")) {
        continue;
      }
      const segments = resolved.split("\r").filter((seg) => seg.length > 0);
      resolved = segments.length > 0 ? segments[segments.length - 1]! : "";
    }
    if (resolved.length > 0 && BRAILLE_SPINNER_LINE.test(resolved.trimStart())) {
      continue;
    }
    cleanedLines.push(resolved);
  }

  return cleanedLines.join("\n").trimEnd();
}

function isPassingTestLine(line: string): boolean {
  return PASSING_TEST_LINE_PATTERNS.some((re) => re.test(line));
}

/**
 * Collapse contiguous runs (`>= 6` lines) of strictly passing test lines across
 * Bun, Vitest, Jest, Mocha, Pytest, Cargo, Go, and Node test runners while
 * preserving 100% of failures, assertion diffs, stack traces, and summaries.
 */
export function collapsePassingTestRuns(text: string): {
  text: string;
  collapsedLines: number;
} {
  const lines = text.split("\n");
  const out: string[] = [];
  let collapsedLines = 0;

  let i = 0;
  while (i < lines.length) {
    if (!isPassingTestLine(lines[i]!)) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < lines.length && isPassingTestLine(lines[end]!)) {
      end += 1;
    }
    const runLen = end - i;
    if (runLen >= MIN_PASSING_RUN_TO_COLLAPSE) {
      out.push(`[... collapsed ${runLen} passing test lines ...]`);
      collapsedLines += runLen;
    } else {
      for (let k = i; k < end; k += 1) {
        out.push(lines[k]!);
      }
    }
    i = end;
  }

  return { text: out.join("\n"), collapsedLines };
}

function factorWorkspacePrefix(lines: readonly string[], workspaceRoot?: string): {
  header: string | null;
  lines: string[];
} {
  const root = (workspaceRoot ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || root.length < 6) {
    return { header: null, lines: [...lines] };
  }
  const prefix = `${root}/`;
  let matchCount = 0;
  for (const line of lines) {
    if (line.startsWith(prefix)) matchCount += 1;
  }
  if (matchCount < 4) {
    return { header: null, lines: [...lines] };
  }
  return {
    header: `[Base directory: ${prefix}]`,
    lines: lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line)),
  };
}

/**
 * Compact noisy `glob` / `grep` / `list` outputs by factoring repetitive
 * workspace root prefixes and collapsing per-directory / per-file match bursts.
 */
export function compactSearchOutput(
  toolName: string,
  text: string,
  workspaceRoot?: string,
): string {
  const lowerTool = toolName.trim().toLowerCase();
  if (lowerTool !== "glob" && lowerTool !== "grep" && lowerTool !== "list" && lowerTool !== "ls") {
    return text;
  }

  const rawLines = text.split("\n");
  const factored = factorWorkspacePrefix(rawLines, workspaceRoot);
  let workingLines = factored.lines;

  if (lowerTool === "glob" && workingLines.length >= 30) {
    const compacted: string[] = [];
    let i = 0;
    while (i < workingLines.length) {
      const line = workingLines[i]!.trim();
      const slashIdx = line.lastIndexOf("/");
      const dir = slashIdx > 0 ? line.slice(0, slashIdx) : "";
      if (!dir) {
        compacted.push(workingLines[i]!);
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < workingLines.length) {
        const candidate = workingLines[end]!.trim();
        const candSlash = candidate.lastIndexOf("/");
        const candDir = candSlash > 0 ? candidate.slice(0, candSlash) : "";
        if (candDir !== dir) break;
        end += 1;
      }
      const groupLen = end - i;
      if (groupLen > 10) {
        for (let k = i; k < i + 5; k += 1) {
          compacted.push(workingLines[k]!);
        }
        compacted.push(`  [... +${groupLen - 5} more files in ${dir}/ ...]`);
      } else {
        for (let k = i; k < end; k += 1) {
          compacted.push(workingLines[k]!);
        }
      }
      i = end;
    }
    workingLines = compacted;
  } else if (lowerTool === "grep" && workingLines.length >= 40) {
    const compacted: string[] = [];
    let i = 0;
    while (i < workingLines.length) {
      const match = /^([^:\r\n]+):\d+:/.exec(workingLines[i]!);
      if (!match) {
        compacted.push(workingLines[i]!);
        i += 1;
        continue;
      }
      const fileKey = match[1]!;
      let end = i + 1;
      while (end < workingLines.length) {
        const nextMatch = /^([^:\r\n]+):\d+:/.exec(workingLines[end]!);
        if (!nextMatch || nextMatch[1] !== fileKey) break;
        end += 1;
      }
      const groupLen = end - i;
      if (groupLen > 12) {
        for (let k = i; k < i + 6; k += 1) {
          compacted.push(workingLines[k]!);
        }
        compacted.push(`  [... +${groupLen - 6} more matches in ${fileKey} ...]`);
      } else {
        for (let k = i; k < end; k += 1) {
          compacted.push(workingLines[k]!);
        }
      }
      i = end;
    }
    workingLines = compacted;
  }

  return factored.header ? `${factored.header}\n${workingLines.join("\n")}` : workingLines.join("\n");
}

function collapseConsecutiveIdenticalLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i]!;
    if (!current.trim()) {
      out.push(current);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end] === current) {
      end += 1;
    }
    const count = end - i;
    if (count >= MIN_IDENTICAL_LOG_RUN) {
      out.push(current);
      out.push(`[... previous line repeated ${count - 1} more times ...]`);
    } else {
      for (let k = i; k < end; k += 1) {
        out.push(lines[k]!);
      }
    }
    i = end;
  }
  return out.join("\n");
}

/**
 * Apply deterministic `"smart"` CLI/search compaction to a non-Read, non-JSON
 * tool output while respecting `SafetyRouter`.
 *
 * Returns `{ output, compacted }` where `compacted === true` only when the
 * transformation passed the Net-Win Gate (`>= 48` UTF-8 bytes saved).
 */
export function applySmartCliTransform(params: {
  tool: CanonicalToolPartIR;
  rawOutput: string;
  safety: ToolSafetyDecision;
  workspaceRoot?: string;
}): { output: string; compacted: boolean; savedBytes: number } {
  const { tool, rawOutput, safety, workspaceRoot } = params;

  // Never alter PEM/credentials, SQL migrations, canonical Read bodies, or structured JSON via lossy CLI filters
  if (
    tool.canonicalRead !== null ||
    tool.parsedOutputJson !== undefined ||
    safety.reasons.includes("credentials_or_pem") ||
    safety.reasons.includes("sql_migration")
  ) {
    return { output: rawOutput, compacted: false, savedBytes: 0 };
  }

  // Passing test runs can be collapsed even when a test suite had 1 failure,
  // because `collapsePassingTestRuns` only touches strictly passing lines and
  // leaves every failed test, assertion diff, stack frame, and summary intact.
  let candidate = stripAnsiAndProgressNoise(rawOutput);
  candidate = collapsePassingTestRuns(candidate).text;

  // All broader search grouping, duplicate-line collapsing, and head+tail CLI log
  // trimming are gated behind `!safety.bypassLossy` (exit 0, zero error/stacktrace signals).
  if (!safety.bypassLossy) {
    candidate = compactSearchOutput(tool.part.tool, candidate, workspaceRoot);
    candidate = collapseConsecutiveIdenticalLines(candidate);

    const candidateLines = candidate.split("\n");
    const candidateBytes = utf8ByteLength(candidate);
    if (
      candidateLines.length > CLI_HEAD_TAIL_LINE_THRESHOLD &&
      candidateBytes > CLI_HEAD_TAIL_BYTE_THRESHOLD
    ) {
      const omitted = candidateLines.length - CLI_KEEP_HEAD_LINES - CLI_KEEP_TAIL_LINES;
      if (omitted >= 20) {
        const head = candidateLines.slice(0, CLI_KEEP_HEAD_LINES).join("\n");
        const tail = candidateLines.slice(candidateLines.length - CLI_KEEP_TAIL_LINES).join("\n");
        candidate = `${head}\n[... omitted ${omitted} middle lines (exit 0, no errors detected) ...]\n${tail}`;
      }
    }
  }

  const originalBytes = utf8ByteLength(rawOutput);
  const newBytes = utf8ByteLength(candidate);
  const saved = originalBytes - newBytes;
  if (saved < MIN_SMART_NET_WIN_BYTES) {
    return { output: rawOutput, compacted: false, savedBytes: 0 };
  }

  return { output: candidate, compacted: true, savedBytes: saved };
}

export type BranchStubIndex = {
  /** Normalized comparable file paths modified anywhere in the visible branch. */
  mutatedPaths: ReadonlySet<string>;
  /** Latest completed CanonicalReadFile tool call per comparablePath in document order. */
  latestReadByPath: ReadonlyMap<string, CanonicalToolPartIR>;
};

function extractPathsFromPatchText(patchText: string): string[] {
  const found: string[] = [];
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    const applyPatchMatch = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line.trim());
    if (applyPatchMatch) {
      found.push(applyPatchMatch[1]!.trim());
      continue;
    }
    const unifiedMatch = /^\+\+\+\s+b\/(.+)$/.exec(line.trim());
    if (unifiedMatch && unifiedMatch[1] !== "/dev/null") {
      found.push(unifiedMatch[1]!.trim());
    }
  }
  return found;
}

function extractMutatedInputPaths(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot?: string,
): string[] {
  const lower = toolName.trim().toLowerCase();
  const rawPaths: string[] = [];

  if (lower === "write" || lower === "edit" || lower === "multiedit") {
    for (const key of ["filePath", "file_path", "path"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim()) {
        rawPaths.push(val.trim());
      }
    }
  } else if (lower === "apply_patch" || lower === "patch") {
    for (const key of ["patchText", "patch", "diff", "content"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim()) {
        rawPaths.push(...extractPathsFromPatchText(val));
      }
    }
    for (const key of ["filePath", "file_path", "path"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim()) {
        rawPaths.push(val.trim());
      }
    }
  }

  return rawPaths
    .map((p) => normalizeComparableFilePath(p, workspaceRoot))
    .filter(Boolean);
}

/**
 * Index all mutated file paths and latest `Read` snapshots across the visible
 * session branch (root + subagents) so `"stubs"` mode keeps the latest context
 * of edited files while stubbing superseded or purely exploratory reads.
 */
export function buildBranchStubIndex(root: CanonicalSessionNodeIR): BranchStubIndex {
  const mutatedPaths = new Set<string>();
  const latestReadByPath = new Map<string, CanonicalToolPartIR>();

  const walk = (node: CanonicalSessionNodeIR) => {
    const workspaceRoot = node.session.directory?.trim() ?? "";
    for (const msg of node.messages) {
      for (const part of msg.parts) {
        if (part.kind === "patch") {
          for (const file of part.files) {
            const norm = normalizeComparableFilePath(file, workspaceRoot);
            if (norm) mutatedPaths.add(norm);
          }
          continue;
        }
        if (part.kind !== "tool") continue;

        if (isPlainObject(part.part.state.input)) {
          const touched = extractMutatedInputPaths(
            part.part.tool,
            part.part.state.input,
            workspaceRoot,
          );
          for (const p of touched) mutatedPaths.add(p);
        }

        if (part.canonicalRead && part.canonicalRead.comparablePath) {
          latestReadByPath.set(part.canonicalRead.comparablePath, part);
        }

        if (part.subagent) {
          walk(part.subagent.node);
        }
      }
    }
  };

  walk(root);
  return { mutatedPaths, latestReadByPath };
}

function sanitizeInlineCode(value: string): string {
  return value.replace(/[`[\]\r\n]+/g, " ").trim();
}

function formatReadShortRange(read: CanonicalReadFile): string {
  if (read.lines.length === 0) return "0 lines";
  const suffix = read.footerKind === "eof" ? ", EOF" : read.truncated ? ", truncated" : "";
  return `L${read.firstLine}–L${read.lastLine}, ${read.lines.length} lines${suffix}`;
}

/**
 * Try converting an eligible read-only inspection tool output into a compact
 * CMV-style stub when `compression === "stubs"`.
 *
 * Never stubs errors, stack traces, non-zero exit codes, credentials/PEM, SQL
 * migrations, mutating tools, or the latest `Read` snapshot of a modified file.
 */
export function tryBuildCompactStub(params: {
  tool: CanonicalToolPartIR;
  safety: ToolSafetyDecision;
  stubIndex: BranchStubIndex;
  rawBaselineBytes: number;
}): { markdownBlock: string; savedBytes: number } | null {
  const { tool, safety, stubIndex, rawBaselineBytes } = params;
  if (safety.bypassLossy || safety.isMutatingTool) return null;

  // Case 1 & 2: Canonical `Read` file outputs
  if (tool.canonicalRead !== null) {
    const read = tool.canonicalRead;
    if (!read.comparablePath) return null;
    const latestForPath = stubIndex.latestReadByPath.get(read.comparablePath);
    const isSupersededByLaterRead =
      Boolean(latestForPath) && latestForPath!.callRefId !== tool.callRefId;
    const pathLabel = sanitizeInlineCode(read.displayPath || read.comparablePath);

    if (
      isSupersededByLaterRead &&
      rawBaselineBytes >= MIN_SUPERSEDED_READ_BYTES &&
      read.lines.length >= MIN_SUPERSEDED_READ_LINES
    ) {
      const stub = `> [Stubbed superseded Read of \`${pathLabel}\` (${formatReadShortRange(read)}) · \`sha256:${shortSha256(read.cleanBodySha256)}\` — latest snapshot in ${latestForPath!.turnLabel}]`;
      const saved = rawBaselineBytes - utf8ByteLength(stub);
      if (saved >= MIN_STUB_NET_WIN_BYTES) {
        return { markdownBlock: stub, savedBytes: saved };
      }
    }

    const wasMutated = stubIndex.mutatedPaths.has(read.comparablePath);
    if (
      !wasMutated &&
      rawBaselineBytes >= MIN_EXPLORATORY_READ_BYTES &&
      read.lines.length >= MIN_EXPLORATORY_READ_LINES
    ) {
      const bodyBytes = utf8ByteLength(read.cleanBody);
      const stub = `> [Stubbed exploratory Read of \`${pathLabel}\` (${formatReadShortRange(read)}, ${bodyBytes.toLocaleString("en-US")} B) · \`sha256:${shortSha256(read.cleanBodySha256)}\` — file unmodified in branch]`;
      const saved = rawBaselineBytes - utf8ByteLength(stub);
      if (saved >= MIN_STUB_NET_WIN_BYTES) {
        return { markdownBlock: stub, savedBytes: saved };
      }
    }

    return null;
  }

  // Case 3: Bulky read-only search / directory / web fetch exploration outputs
  const lowerTool = tool.part.tool.trim().toLowerCase();
  if (!EXPLORATORY_INSPECTION_TOOLS.has(lowerTool) || tool.normalizedOutput === null) {
    return null;
  }
  if (
    tool.outputLineCount < MIN_EXPLORATORY_TOOL_LINES &&
    tool.outputBytes < MIN_EXPLORATORY_TOOL_BYTES
  ) {
    return null;
  }

  const allLines = tool.normalizedOutput.split("\n");
  if (allLines.length <= STUB_PREVIEW_LINES + 2) return null;

  const previewLines = allLines.slice(0, STUB_PREVIEW_LINES);
  const remaining = allLines.length - STUB_PREVIEW_LINES;
  const shaNote = tool.outputSha256 ? ` · \`sha256:${shortSha256(tool.outputSha256)}\`` : "";
  const header = `> [Stubbed exploratory ${sanitizeInlineCode(tool.displayName)} output (${allLines.length} lines, ${tool.outputBytes.toLocaleString("en-US")} B${shaNote})]`;
  const previewFence = fenceMarkdownCode(
    `${previewLines.join("\n")}\n[... ${remaining} additional lines stubbed in stubs mode ...]`,
  );
  const combined = `${header}\n\n${previewFence}`;
  const saved = rawBaselineBytes - utf8ByteLength(combined);
  if (saved < MIN_STUB_NET_WIN_BYTES) return null;

  return { markdownBlock: combined, savedBytes: saved };
}
