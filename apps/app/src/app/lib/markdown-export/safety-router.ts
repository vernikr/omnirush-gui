import { isPlainObject } from "./structured-compact";
import type {
  CanonicalToolPartIR,
  SafetyBypassReason,
  ToolSafetyDecision,
} from "./types";

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "patch",
  "todowrite",
]);

const NONZERO_EXIT_LINE_PATTERN =
  /^(?:Exit status|Process exited with code|Exited with code|Command failed with exit code)\s+([1-9]\d*)\b/m;

const STACK_TRACE_PATTERNS: readonly RegExp[] = [
  // V8 / Node / Bun / browser stack frames
  /^\s+at\s+(?:async\s+)?[^\r\n]{1,200}\([^()\r\n]{1,260}:\d+:\d+\)/m,
  /^\s+at\s+(?:file:\/\/|\/|[A-Za-z]:\\)[^\s\r\n]{1,260}:\d+:\d+/m,
  // Python traceback
  /^Traceback \(most recent call last\):/m,
  // Rust / Go panics & fatal errors
  /^thread '[^'\r\n]+' panicked at /m,
  /^panic:\s+\S/m,
  /^goroutine \d+ \[running\]:/m,
  /^fatal error:\s+\S/m,
  // Unhandled JS/TS/runtime errors & package manager errors
  /^(?:Uncaught\s+)?(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AssertionError|AggregateError|FATAL ERROR):\s+\S/m,
  /^(?:npm ERR!|ERR_PNPM_[A-Z0-9_]+|Segmentation fault|Bus error)\b/m,
];

const COMPILER_ERROR_PATTERNS: readonly RegExp[] = [
  // TypeScript compiler (`foo.ts(12,5): error TS2322:` or `foo.ts:12:5 - error TS2322:`)
  /\(\d+,\d+\):\s+error TS\d{4,5}:/m,
  /:\d+:\d+\s*-\s*error TS\d{4,5}:/m,
  // Rust / GCC / Clang / Go compiler diagnostics
  /^error\[E\d{4}\]:/m,
  /^[^\s:\r\n]+:\d+:\d+:\s+(?:fatal\s+)?error:\s+\S/m,
];

const PEM_OR_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{3,48}-----/,
  /^(?:export\s+)?[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|API_KEY|AUTH_TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*['"]?[A-Za-z0-9+/=_\-.]{8,}/m,
];

const SQL_MIGRATION_PATTERN =
  /^\s*(?:CREATE\s+(?:TABLE|UNIQUE\s+INDEX|INDEX|VIEW|MATERIALIZED\s+VIEW|TYPE|FUNCTION|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TYPE)|BEGIN\s+TRANSACTION)\b/im;

function extractNumericExitCode(metadata: Record<string, unknown> | undefined): number | null {
  if (!metadata) return null;
  for (const key of ["exit", "exitCode", "code"]) {
    const val = metadata[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}

/**
 * Deterministic Safety Router protecting diagnostic errors, stack traces,
 * non-zero exit statuses, credentials/PEM blocks, SQL migrations, and
 * workspace-mutating tools from lossy truncation or stubbing in `"smart"` and
 * `"stubs"` compression modes.
 */
export function classifyToolSafety(tool: CanonicalToolPartIR): ToolSafetyDecision {
  const reasons: SafetyBypassReason[] = [];
  const lowerTool = tool.part.tool.trim().toLowerCase();
  const isMutatingTool = MUTATING_TOOLS.has(lowerTool);

  if (isMutatingTool) {
    reasons.push("mutating_tool");
  }

  const state = tool.part.state;
  const codeModeFailed =
    Boolean(tool.part.metadata && tool.part.metadata.omnirushV2CodeMode === true) &&
    state.status === "completed" &&
    Boolean(state.metadata && state.metadata.error === true);

  if (state.status === "error" || tool.errorText !== null || codeModeFailed) {
    reasons.push("tool_error_status");
  }

  const metadataRecord =
    (state.status === "completed" || state.status === "running" || state.status === "error") &&
    isPlainObject(state.metadata)
      ? state.metadata
      : undefined;
  const exitCode = extractNumericExitCode(metadataRecord);
  if (exitCode !== null && exitCode !== 0) {
    reasons.push("nonzero_exit_code");
  }

  const textToInspect =
    tool.canonicalRead !== null ? tool.canonicalRead.cleanBody : (tool.normalizedOutput ?? "");

  if (textToInspect) {
    if (
      !reasons.includes("nonzero_exit_code") &&
      tool.canonicalRead === null &&
      NONZERO_EXIT_LINE_PATTERN.test(textToInspect)
    ) {
      reasons.push("nonzero_exit_code");
    }

    if (PEM_OR_SECRET_PATTERNS.some((re) => re.test(textToInspect))) {
      reasons.push("credentials_or_pem");
    }

    if (SQL_MIGRATION_PATTERN.test(textToInspect)) {
      reasons.push("sql_migration");
    }

    // Stack traces and compiler error lines are CLI/diagnostic signals (not static source files opened via Read)
    if (tool.canonicalRead === null) {
      if (STACK_TRACE_PATTERNS.some((re) => re.test(textToInspect))) {
        reasons.push("stack_trace_or_exception");
      }
      if (COMPILER_ERROR_PATTERNS.some((re) => re.test(textToInspect))) {
        reasons.push("compiler_diagnostic_error");
      }
    }
  }

  return {
    bypassLossy: reasons.length > 0,
    isMutatingTool,
    reasons,
  };
}
