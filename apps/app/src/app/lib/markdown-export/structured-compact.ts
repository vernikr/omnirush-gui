import { utf8ByteLength } from "./hash-and-bytes";

export const TOON_HEADER_LINE = "# TOON-JSON v1 (lossless tabular JSON)";

const MAX_COMPACT_INPUT_CHARS = 140;
const MIN_TOON_ROWS = 4;
const MIN_TOON_SAVED_BYTES = 120;
const MIN_TOON_SAVED_RATIO = 0.15;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Compute a backtick code fence guaranteed to be strictly longer than any
 * contiguous run of backticks inside `content`, preventing Markdown injection
 * or broken code blocks even when exporting conversations containing Markdown.
 */
export function fenceMarkdownCode(
  content: string,
  language = "",
  preserveTrailingNewline = false,
): string {
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
  const body =
    !preserveTrailingNewline && normalized.endsWith("\n")
      ? normalized.slice(0, -1)
      : normalized;
  return `${fence}${safeLang}\n${body}\n${fence}`;
}

export function safeJsonStringify(value: unknown, space: number | undefined = 2): string {
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
      space,
    );
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value);
  return false;
}

/**
 * Render small, single-line-friendly tool `input` objects on one line (`{"filePath": "a.ts", "offset": 1}`)
 * when `<= 140` chars and free of embedded newlines. Returns `null` when multi-line pretty JSON is clearer.
 */
export function tryFormatCompactJsonInput(input: Record<string, unknown>): string | null {
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.length > 6) return null;
  for (const key of keys) {
    const val = input[key];
    if (!isJsonPrimitive(val)) return null;
    if (typeof val === "string" && (val.includes("\n") || val.includes("\r") || val.length > 96)) {
      return null;
    }
  }
  const parts = keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(input[key])}`);
  const compact = `{${parts.join(", ")}}`;
  return compact.length <= MAX_COMPACT_INPUT_CHARS ? compact : null;
}

function checkUniformPrimitiveRows(rows: unknown[]): { keys: string[]; objects: Record<string, unknown>[] } | null {
  if (rows.length < MIN_TOON_ROWS) return null;
  const first = rows[0];
  if (!isPlainObject(first)) return null;
  const keys = Object.keys(first);
  if (keys.length === 0 || keys.length > 24) return null;

  const objects: Record<string, unknown>[] = [];
  for (const item of rows) {
    if (!isPlainObject(item)) return null;
    const itemKeys = Object.keys(item);
    if (itemKeys.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i]!;
      if (itemKeys[i] !== k) return null;
      if (!isJsonPrimitive(item[k])) return null;
    }
    objects.push(item);
  }
  return { keys, objects };
}

/**
 * Encode uniform JSON object arrays (either top-level `[...]` or a plain wrapper
 * object with primitive metadata fields + exactly one uniform object array) into a
 * strictly lossless, deterministic TOON-JSON v1 table.
 *
 * Returns `null` unless the structure is 100% lossless-eligible AND passes the
 * Net-Win Gate (`>= 120` bytes and `>= 15%` smaller than pretty-printed JSON).
 */
export function tryEncodeLosslessToon(parsedJson: unknown, prettyJsonBaseline: string): string | null {
  let candidateLines: string[] | null = null;

  if (Array.isArray(parsedJson)) {
    const uniform = checkUniformPrimitiveRows(parsedJson);
    if (!uniform) return null;
    const headerCols = uniform.keys.map((k) => JSON.stringify(k)).join(",");
    candidateLines = [
      TOON_HEADER_LINE,
      `[${uniform.objects.length}]{${headerCols}}:`,
      ...uniform.objects.map(
        (row) => `  ${uniform.keys.map((k) => JSON.stringify(row[k])).join(",")}`,
      ),
    ];
  } else if (isPlainObject(parsedJson)) {
    const entries = Object.entries(parsedJson);
    if (entries.length === 0 || entries.length > 8) return null;
    let arrayEntryIndex = -1;
    for (let i = 0; i < entries.length; i += 1) {
      const [, val] = entries[i]!;
      if (Array.isArray(val)) {
        if (arrayEntryIndex !== -1) return null;
        arrayEntryIndex = i;
      } else if (!isJsonPrimitive(val)) {
        return null;
      }
    }
    if (arrayEntryIndex === -1) return null;
    const [arrayKey, rawRows] = entries[arrayEntryIndex]!;
    const uniform = checkUniformPrimitiveRows(rawRows as unknown[]);
    if (!uniform) return null;

    const lines: string[] = [TOON_HEADER_LINE];
    for (let i = 0; i < entries.length; i += 1) {
      const [key, val] = entries[i]!;
      if (i === arrayEntryIndex) {
        const headerCols = uniform.keys.map((k) => JSON.stringify(k)).join(",");
        lines.push(`${JSON.stringify(arrayKey)}[${uniform.objects.length}]{${headerCols}}:`);
        for (const row of uniform.objects) {
          lines.push(`  ${uniform.keys.map((k) => JSON.stringify(row[k])).join(",")}`);
        }
      } else {
        lines.push(`${JSON.stringify(key)}: ${JSON.stringify(val)}`);
      }
    }
    candidateLines = lines;
  }

  if (!candidateLines) return null;
  const encoded = candidateLines.join("\n");
  const baselineBytes = utf8ByteLength(prettyJsonBaseline);
  const encodedBytes = utf8ByteLength(encoded);
  const saved = baselineBytes - encodedBytes;
  if (saved < MIN_TOON_SAVED_BYTES || saved / baselineBytes < MIN_TOON_SAVED_RATIO) {
    return null;
  }
  return encoded;
}

/**
 * Parse a comma-separated sequence of `JSON.stringify` tokens on a single line.
 */
function parseJsonTupleLine(line: string): unknown[] {
  const parsed: unknown = JSON.parse(`[${line}]`);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid TOON tuple row");
  }
  return parsed;
}

/**
 * Decode a `TOON-JSON v1` block back into the exact original JS value
 * (`Array<Record<string, unknown>>` or wrapper `Record<string, unknown>`).
 */
export function decodeLosslessToon(toonText: string): unknown {
  const lines = normalizeNewlines(toonText).trim().split("\n");
  if (lines[0]?.trim() !== TOON_HEADER_LINE) {
    throw new Error("Missing TOON-JSON v1 header");
  }

  const rootArrayMatch = /^\[(\d+)\]\{(.+)\}:$/.exec(lines[1]?.trim() ?? "");
  if (rootArrayMatch) {
    const expectedCount = Number(rootArrayMatch[1]);
    const keys = parseJsonTupleLine(rootArrayMatch[2]!) as string[];
    const rows: Record<string, unknown>[] = [];
    for (let i = 2; i < lines.length; i += 1) {
      const rawRow = lines[i]!;
      if (!rawRow.trim()) continue;
      if (!rawRow.startsWith("  ")) {
        throw new Error(`Unexpected root TOON row indentation at line ${i + 1}`);
      }
      const values = parseJsonTupleLine(rawRow.slice(2));
      if (values.length !== keys.length) {
        throw new Error(`TOON row column count mismatch at line ${i + 1}`);
      }
      const obj: Record<string, unknown> = {};
      for (let c = 0; c < keys.length; c += 1) {
        obj[keys[c]!] = values[c];
      }
      rows.push(obj);
    }
    if (rows.length !== expectedCount) {
      throw new Error(`TOON row count mismatch: expected ${expectedCount}, got ${rows.length}`);
    }
    return rows;
  }

  const result: Record<string, unknown> = {};
  let idx = 1;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (!line.trim()) {
      idx += 1;
      continue;
    }
    const tableFieldMatch = /^("(?:[^"\\]|\\.)*")\[(\d+)\]\{(.+)\}:$/.exec(line.trim());
    if (tableFieldMatch) {
      const fieldKey = JSON.parse(tableFieldMatch[1]!) as string;
      const expectedCount = Number(tableFieldMatch[2]);
      const keys = parseJsonTupleLine(tableFieldMatch[3]!) as string[];
      const rows: Record<string, unknown>[] = [];
      idx += 1;
      for (let r = 0; r < expectedCount; r += 1) {
        const rowLine = lines[idx];
        if (rowLine === undefined || !rowLine.startsWith("  ")) {
          throw new Error(`Missing indented TOON row for field ${fieldKey}`);
        }
        const values = parseJsonTupleLine(rowLine.slice(2));
        if (values.length !== keys.length) {
          throw new Error(`Column count mismatch in TOON field ${fieldKey}`);
        }
        const obj: Record<string, unknown> = {};
        for (let c = 0; c < keys.length; c += 1) {
          obj[keys[c]!] = values[c];
        }
        rows.push(obj);
        idx += 1;
      }
      result[fieldKey] = rows;
      continue;
    }

    const kvMatch = /^("(?:[^"\\]|\\.)*"):\s+(.+)$/.exec(line.trim());
    if (!kvMatch) {
      throw new Error(`Invalid TOON wrapper property line: ${line}`);
    }
    const propKey = JSON.parse(kvMatch[1]!) as string;
    const propVal: unknown = JSON.parse(kvMatch[2]!);
    result[propKey] = propVal;
    idx += 1;
  }

  return result;
}
