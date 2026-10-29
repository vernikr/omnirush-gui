import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWindowZoomController } from "./window-zoom.mjs";

/**
 * @param {{ visible?: boolean; initialZoom?: number }} [options]
 */
function createFakeWindow(options = {}) {
  let visible = options.visible ?? false;
  let zoomFactor = options.initialZoom ?? 1;
  let destroyed = false;
  /** @type {Map<string, Array<() => void>>} */
  const windowListeners = new Map();
  /** @type {Map<string, Array<() => void>>} */
  const contentsListeners = new Map();
  /** @type {number[]} */
  const setCalls = [];

  /**
   * @param {Map<string, Array<() => void>>} registry
   * @param {string} event
   * @param {() => void} listener
   */
  const addListener = (registry, event, listener) => {
    const list = registry.get(event) ?? [];
    list.push(listener);
    registry.set(event, list);
  };

  /**
   * @param {Map<string, Array<() => void>>} registry
   * @param {string} event
   */
  const emit = (registry, event) => {
    for (const listener of registry.get(event) ?? []) {
      listener();
    }
  };

  const win = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    /**
     * @param {string} event
     * @param {() => void} listener
     */
    on(event, listener) {
      addListener(windowListeners, event, listener);
      return win;
    },
    webContents: {
      isDestroyed: () => destroyed,
      getZoomFactor: () => zoomFactor,
      /**
       * @param {number} factor
       */
      setZoomFactor(factor) {
        zoomFactor = factor;
        setCalls.push(factor);
      },
      /**
       * @param {string} event
       * @param {() => void} listener
       */
      on(event, listener) {
        addListener(contentsListeners, event, listener);
        return win.webContents;
      },
    },
    show() {
      visible = true;
      emit(windowListeners, "show");
    },
    emitInPageNavigation(resetZoomTo = zoomFactor) {
      zoomFactor = resetZoomTo;
      emit(contentsListeners, "did-navigate-in-page");
    },
    destroy() {
      destroyed = true;
    },
    get setCalls() {
      return setCalls;
    },
  };

  return win;
}

describe("window zoom controller", () => {
  it("defers webContents.setZoomFactor while the window is hidden until show", () => {
    const controller = createWindowZoomController();
    const win = createFakeWindow({ visible: false, initialZoom: 1 });

    assert.equal(controller.setFactor(win, 1.3), true);
    assert.equal(controller.getDesiredFactor(win), 1.3);
    assert.deepEqual(win.setCalls, []);

    win.show();
    assert.deepEqual(win.setCalls, [1.3]);
    assert.equal(win.webContents.getZoomFactor(), 1.3);
  });

  it("forces pending zoom sync on show even if HostZoomMap reported the same cached factor", () => {
    const controller = createWindowZoomController();
    const win = createFakeWindow({ visible: false, initialZoom: 1.3 });

    assert.equal(controller.setFactor(win, 1.3), true);
    assert.deepEqual(win.setCalls, []);

    win.show();
    assert.deepEqual(win.setCalls, [1.3]);
  });

  it("restores zoom when a file:// in-page hash navigation resets WebContents zoom to 1", () => {
    const controller = createWindowZoomController();
    const win = createFakeWindow({ visible: true, initialZoom: 1 });

    assert.equal(controller.setFactor(win, 1.4), true);
    assert.deepEqual(win.setCalls, [1.4]);

    // Unchanged zoom on hash navigation avoids redundant setZoomFactor calls.
    win.emitInPageNavigation(1.4);
    assert.deepEqual(win.setCalls, [1.4]);

    // A fragment-keyed HostZoomMap reset to 1.0 is immediately corrected.
    win.emitInPageNavigation(1.0);
    assert.deepEqual(win.setCalls, [1.4, 1.4]);
    assert.equal(win.webContents.getZoomFactor(), 1.4);
  });

  it("rejects invalid zoom values and destroyed windows", () => {
    const controller = createWindowZoomController();
    const win = createFakeWindow({ visible: true });

    assert.equal(controller.setFactor(win, 0), false);
    assert.equal(controller.setFactor(win, -1), false);
    assert.equal(controller.setFactor(win, Number.NaN), false);
    assert.equal(controller.setFactor(null, 1.2), false);

    win.destroy();
    assert.equal(controller.setFactor(win, 1.2), false);
  });
});
