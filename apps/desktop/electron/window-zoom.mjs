/**
 * Keeps each BrowserWindow's desired UI zoom factor synchronized without
 * calling webContents.setZoomFactor while the window is still hidden before
 * ready-to-show (electron#51972) or losing zoom across file:// #hash route
 * transitions on Electron <43.3 (electron#54381).
 *
 * @typedef {{
 *   isDestroyed?: () => boolean;
 *   getZoomFactor?: () => number;
 *   setZoomFactor?: (factor: number) => void;
 *   on?: (event: string, listener: () => void) => unknown;
 * }} ZoomableWebContents
 *
 * @typedef {{
 *   isDestroyed?: () => boolean;
 *   isVisible?: () => boolean;
 *   on?: (event: string, listener: () => void) => unknown;
 *   webContents?: ZoomableWebContents | null;
 * }} ZoomableWindow
 */

/**
 * @param {ZoomableWindow | null | undefined} win
 * @returns {win is ZoomableWindow}
 */
function isUsableWindow(win) {
  return Boolean(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

/**
 * @param {ZoomableWindow | null | undefined} win
 */
function isWindowVisible(win) {
  if (!isUsableWindow(win)) return false;
  return typeof win.isVisible === "function" ? Boolean(win.isVisible()) : true;
}

export function createWindowZoomController() {
  /** @type {WeakMap<ZoomableWindow, number>} */
  const desiredFactors = new WeakMap();
  /** @type {WeakSet<ZoomableWindow>} */
  const attachedWindows = new WeakSet();
  /** @type {WeakSet<ZoomableWindow>} */
  const pendingWindows = new WeakSet();

  /**
   * @param {ZoomableWindow | null | undefined} win
   */
  function syncVisibleWindowZoom(win) {
    if (!isUsableWindow(win) || !isWindowVisible(win)) return false;
    const factor = desiredFactors.get(win);
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
      return false;
    }
    const contents = win.webContents;
    if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) {
      return false;
    }
    const pending = pendingWindows.delete(win);
    if (!pending && typeof contents.getZoomFactor === "function") {
      const current = contents.getZoomFactor();
      if (Number.isFinite(current) && Math.abs(current - factor) <= 1e-3) {
        return true;
      }
    }
    contents.setZoomFactor?.(factor);
    return true;
  }

  /**
   * @param {ZoomableWindow | null | undefined} win
   */
  function attach(win) {
    if (!isUsableWindow(win) || attachedWindows.has(win)) return;
    attachedWindows.add(win);
    const resync = () => {
      syncVisibleWindowZoom(win);
    };
    if (typeof win.on === "function") {
      win.on("show", resync);
      win.on("restore", resync);
    }
    const contents = win.webContents;
    if (contents && typeof contents.on === "function") {
      contents.on("did-finish-load", resync);
      contents.on("did-navigate-in-page", resync);
    }
  }

  /**
   * @param {ZoomableWindow | null | undefined} win
   * @param {number} rawFactor
   */
  function setFactor(win, rawFactor) {
    const factor = Number(rawFactor);
    if (!isUsableWindow(win) || !Number.isFinite(factor) || factor <= 0) {
      return false;
    }
    attach(win);
    desiredFactors.set(win, factor);
    if (!isWindowVisible(win)) {
      pendingWindows.add(win);
      return true;
    }
    pendingWindows.delete(win);
    win.webContents?.setZoomFactor?.(factor);
    return true;
  }

  /**
   * @param {ZoomableWindow | null | undefined} win
   */
  function getDesiredFactor(win) {
    if (!isUsableWindow(win)) return null;
    return desiredFactors.get(win) ?? null;
  }

  return {
    attach,
    setFactor,
    getDesiredFactor,
    syncVisibleWindowZoom,
  };
}
