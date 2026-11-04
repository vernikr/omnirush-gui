import { sha256Hex } from "./hash-and-bytes";
import { normalizeNewlines } from "./structured-compact";

const MIN_SKIP_UNCHANGED_RUN = 4;
const MAX_MYERS_EDIT_DISTANCE = 600;
const KEEP_DIRECTIVE_PATTERN = /^@@ keep base (\d+)\.\.(\d+) \((\d+) unchanged lines\) @@$/;

type DiffOp =
  | { type: "equal"; baseStart: number; count: number; lines: string[] }
  | { type: "delete"; lines: string[] }
  | { type: "insert"; lines: string[] };

/**
 * Bounded Myers O(ND) diff over trimmed interior lines. Returns `null` if the
 * edit distance exceeds `MAX_MYERS_EDIT_DISTANCE` (meaning the file was heavily
 * rewritten and a full Read snapshot is both smaller and clearer than a delta).
 */
function myersDiffLines(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "insert", lines: [...b] }];
  if (m === 0) return [{ type: "delete", lines: [...a] }];

  const maxD = Math.min(n + m, MAX_MYERS_EDIT_DISTANCE);
  const offset = n + m;
  const v = new Int32Array(2 * offset + 1);
  v.fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[kIdx - 1]! < v[kIdx + 1]!)) {
        x = v[kIdx + 1]!;
      } else {
        x = v[kIdx - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[kIdx] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD !== -1) break;
  }

  if (foundD === -1) return null;

  type RawStep = { kind: "eq"; baseIdx: number; line: string } | { kind: "del"; line: string } | { kind: "ins"; line: string };
  const revSteps: RawStep[] = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d -= 1) {
    const prevV = trace[d]!;
    const k = x - y;
    const kIdx = offset + k;
    let prevK: number;
    if (k === -d || (k !== d && prevV[kIdx - 1]! < prevV[kIdx + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prevV[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      revSteps.push({ kind: "eq", baseIdx: x, line: a[x]! });
    }
    if (x === prevX) {
      y -= 1;
      revSteps.push({ kind: "ins", line: b[y]! });
    } else {
      x -= 1;
      revSteps.push({ kind: "del", line: a[x]! });
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    revSteps.push({ kind: "eq", baseIdx: x, line: a[x]! });
  }

  revSteps.reverse();
  const ops: DiffOp[] = [];
  for (const step of revSteps) {
    const last = ops.at(-1);
    if (step.kind === "eq") {
      if (last && last.type === "equal") {
        last.count += 1;
        last.lines.push(step.line);
      } else {
        ops.push({ type: "equal", baseStart: step.baseIdx, count: 1, lines: [step.line] });
      }
    } else if (step.kind === "del") {
      if (last && last.type === "delete") {
        last.lines.push(step.line);
      } else {
        ops.push({ type: "delete", lines: [step.line] });
      }
    } else {
      if (last && last.type === "insert") {
        last.lines.push(step.line);
      } else {
        ops.push({ type: "insert", lines: [step.line] });
      }
    }
  }
  return ops;
}

/**
 * Compute a deterministic, self-verifying lossless line delta from `baseLines`
 * to `targetLines`.
 *
 * Format rules inside the `diff` code block:
 * - Unchanged runs of `>= 4` lines emit `@@ keep base A..B (N unchanged lines) @@`
 *   (1-based inclusive indices into `baseLines`), keeping 1 context line adjacent
 *   to edits when interior runs are long enough so humans also have visual context.
 * - Short unchanged runs (`1..3` lines) or edge context lines emit `" " + line`.
 * - Deleted base lines emit `"-" + line`.
 * - Inserted target lines emit `"+" + line`.
 *
 * Every emitted delta is immediately expanded in-memory and verified against
 * `expectedTargetSha256` before returning; returns `null` if heavily rewritten
 * or if verification fails.
 */
export function computeLosslessFileDelta(
  baseLines: readonly string[],
  targetLines: readonly string[],
  expectedTargetSha256: string,
): string | null {
  if (baseLines.length === 0 || targetLines.length === 0) return null;

  let prefixLen = 0;
  const minLen = Math.min(baseLines.length, targetLines.length);
  while (prefixLen < minLen && baseLines[prefixLen] === targetLines[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    baseLines[baseLines.length - 1 - suffixLen] === targetLines[targetLines.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const midBase = baseLines.slice(prefixLen, baseLines.length - suffixLen);
  const midTarget = targetLines.slice(prefixLen, targetLines.length - suffixLen);
  const midOps = myersDiffLines(midBase, midTarget);
  if (!midOps) return null;

  const allOps: DiffOp[] = [];
  if (prefixLen > 0) {
    allOps.push({
      type: "equal",
      baseStart: 0,
      count: prefixLen,
      lines: baseLines.slice(0, prefixLen),
    });
  }
  for (const op of midOps) {
    if (op.type === "equal") {
      allOps.push({
        type: "equal",
        baseStart: prefixLen + op.baseStart,
        count: op.count,
        lines: op.lines,
      });
    } else {
      allOps.push(op);
    }
  }
  if (suffixLen > 0) {
    const suffixStart = baseLines.length - suffixLen;
    allOps.push({
      type: "equal",
      baseStart: suffixStart,
      count: suffixLen,
      lines: baseLines.slice(suffixStart),
    });
  }

  const outLines: string[] = [];
  for (let i = 0; i < allOps.length; i += 1) {
    const op = allOps[i]!;
    if (op.type === "delete") {
      for (const line of op.lines) outLines.push(`-${line}`);
      continue;
    }
    if (op.type === "insert") {
      for (const line of op.lines) outLines.push(`+${line}`);
      continue;
    }

    const hasEditBefore = i > 0;
    const hasEditAfter = i < allOps.length - 1;
    const leadContext = hasEditBefore ? 1 : 0;
    const trailContext = hasEditAfter ? 1 : 0;
    const skippable = op.count - leadContext - trailContext;

    if (skippable >= MIN_SKIP_UNCHANGED_RUN) {
      if (leadContext > 0) {
        outLines.push(` ${op.lines[0]!}`);
      }
      const skipStart1Based = op.baseStart + leadContext + 1;
      const skipEnd1Based = op.baseStart + op.count - trailContext;
      outLines.push(
        `@@ keep base ${skipStart1Based}..${skipEnd1Based} (${skippable} unchanged lines) @@`,
      );
      if (trailContext > 0) {
        outLines.push(` ${op.lines[op.lines.length - 1]!}`);
      }
    } else {
      for (const line of op.lines) {
        outLines.push(` ${line}`);
      }
    }
  }

  const deltaBody = outLines.join("\n");
  try {
    const reconstructedLines = applyLosslessFileDelta(baseLines, deltaBody);
    const reconstructedBody = reconstructedLines.join("\n");
    if (sha256Hex(reconstructedBody) !== expectedTargetSha256) {
      return null;
    }
  } catch {
    return null;
  }

  return deltaBody;
}

/**
 * Deterministically reconstruct `targetLines` from `baseLines` and a lossless
 * `deltaBody` emitted by `computeLosslessFileDelta`.
 */
export function applyLosslessFileDelta(baseLines: readonly string[], deltaBody: string): string[] {
  const rawLines = normalizeNewlines(deltaBody).split("\n");
  const target: string[] = [];

  for (const rawLine of rawLines) {
    const keepMatch = KEEP_DIRECTIVE_PATTERN.exec(rawLine);
    if (keepMatch) {
      const start1 = Number(keepMatch[1]);
      const end1 = Number(keepMatch[2]);
      const expectedCount = Number(keepMatch[3]);
      if (
        start1 < 1 ||
        end1 < start1 ||
        end1 > baseLines.length ||
        end1 - start1 + 1 !== expectedCount
      ) {
        throw new Error(`Invalid keep-base range ${start1}..${end1} for base of ${baseLines.length} lines`);
      }
      for (let idx = start1 - 1; idx < end1; idx += 1) {
        target.push(baseLines[idx]!);
      }
      continue;
    }

    const prefix = rawLine[0];
    if (prefix === " " || prefix === "+") {
      target.push(rawLine.slice(1));
    } else if (prefix === "-") {
      continue;
    } else {
      throw new Error(`Unexpected line in lossless file delta: ${rawLine}`);
    }
  }

  return target;
}
