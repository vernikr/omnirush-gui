/** The side panel's width is remembered across open/close cycles. */

export const MIN_SIDE_PANEL_WIDTH = 320;

type PanelSizeRef = { current: { getSize: () => { inPixels: number } } | null } | null | undefined;

/**
 * Commits a side-panel width from `onLayoutChanged`.
 *
 * The layout callback fires before the panel's inline style (and therefore its
 * measured width) has been updated, so reading the width inside the callback
 * returns the *previous* one. Callers must read on the next frame, once layout
 * has settled — see `scheduleSidePanelWidthCommit`.
 *
 * Two more transient states must never become the remembered width: a panel
 * that is mounting reports 0 and then a handful of pixels, and a panel whose
 * group is not laid out yet reports nothing useful. Only a size that is at
 * least the panel minimum counts, and a size equal to the last committed one is
 * ignored so a stream of layout events cannot loop through state.
 *
 * Returns whether anything was committed.
 */
export function commitSidePanelWidth(
  panelRef: PanelSizeRef,
  lastCommitted: { current: number },
  commit: (width: number) => void,
): boolean {
  const size = panelRef?.current?.getSize();
  if (!size || !Number.isFinite(size.inPixels) || size.inPixels < MIN_SIDE_PANEL_WIDTH) return false;

  const width = Math.round(size.inPixels);
  if (width === lastCommitted.current) return false;

  lastCommitted.current = width;
  commit(width);
  return true;
}

type FrameHandle = { current: number | null };

/**
 * Commits the panel width on the next animation frame, coalescing the burst of
 * layout events a single drag produces into one commit. Returns a cancel
 * function; the owner is expected to call it on unmount or when the panel
 * closes.
 */
export function scheduleSidePanelWidthCommit(
  frame: FrameHandle,
  commit: () => void,
  frameApi: Pick<typeof globalThis, "requestAnimationFrame" | "cancelAnimationFrame"> = globalThis,
): () => void {
  if (frame.current !== null) frameApi.cancelAnimationFrame(frame.current);
  frame.current = frameApi.requestAnimationFrame(() => {
    frame.current = null;
    commit();
  });
  return () => {
    if (frame.current === null) return;
    frameApi.cancelAnimationFrame(frame.current);
    frame.current = null;
  };
}
