/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";

/**
 * A streaming answer re-lexes, re-parses and re-sanitizes only the blocks that
 * are still growing, so a short answer can follow the token rate and keep the
 * typing feel for free.
 *
 * A long answer is a different shape. Models write their reasoning as one
 * paragraph, so the `STREAMING_RELEX_TAIL` window of
 * `createStreamingMarkdownRenderer` collapses to that single block and every
 * render costs the whole text so far — a full lexer pass, a full inline parse,
 * a full DOMPurify pass and the layout of the resulting HTML. That cost grows
 * linearly with the block, which makes rendering it on every frame quadratic
 * over the turn: at 60 KB of one-paragraph text a single pass already takes
 * tens of milliseconds, i.e. several CPU-seconds per second of streaming.
 *
 * So above `STREAMING_RENDER_EAGER_CHARS` the text is published on a timer
 * whose period is derived from the measured cost of the last render: the
 * renderer is allowed to spend roughly `STREAMING_RENDER_BUDGET` of a core on
 * itself and no more. A short block still updates ~12 times a second; a very
 * long one slows down to about once a second, which is what a trace that size
 * looks like anyway. The eye reads text that arrives while scrolling, and the
 * write is always complete and in order — nothing is dropped.
 */
export const STREAMING_RENDER_EAGER_CHARS = 2_048;

/** Never publish slower than this while a block is streaming. */
export const STREAMING_RENDER_MIN_INTERVAL_MS = 80;

/** …and never slower than this, however expensive one render gets. */
export const STREAMING_RENDER_MAX_INTERVAL_MS = 1_500;

/** Share of one core the markdown renderer may use while a block streams. */
export const STREAMING_RENDER_BUDGET = 0.1;

/**
 * The text a streaming markdown block should render right now.
 *
 * `renderCostMs` is how long the caller's last render of this block took; the
 * hook turns it into the publish period. Short text is returned unchanged, so
 * callers that never grow this large pay nothing.
 */
export function useStreamingRenderPace(text: string, streaming: boolean, renderCostMs: number): string {
  const paced = streaming && text.length > STREAMING_RENDER_EAGER_CHARS;
  const [published, setPublished] = useState(text);
  const latest = useRef(text);
  const cost = useRef(renderCostMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = text;
  cost.current = renderCostMs;

  // Deliberately no dependency list: this runs after every render, keeps at
  // most one publish scheduled while text is arriving, and hands the real text
  // back as soon as the block stops being paced. A block that stops growing
  // fires the pending publish once and then schedules nothing more.
  useEffect(() => {
    if (!paced) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (published !== text) setPublished(text);
      return;
    }
    if (timer.current !== null) return;
    const budgeted = Math.round(cost.current / STREAMING_RENDER_BUDGET);
    const interval = Math.min(
      STREAMING_RENDER_MAX_INTERVAL_MS,
      Math.max(STREAMING_RENDER_MIN_INTERVAL_MS, budgeted),
    );
    timer.current = setTimeout(() => {
      timer.current = null;
      setPublished(latest.current);
    }, interval);
  });

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return paced ? published : text;
}
