import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDesktopZoomFactor, setDesktopZoomFactor } from "../src/app/lib/desktop";
import { FONT_ZOOM_STORAGE_KEY } from "../src/app/lib/font-zoom";
import { attachDesktopFontZoomBehavior } from "../src/react-app/shell/font-zoom";

let registeredDom = false;

beforeEach(() => {
  registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

afterEach(async () => {
  if (typeof globalThis.window !== "undefined") {
    Reflect.deleteProperty(globalThis.window, "__OMNIRUSH_ELECTRON__");
  }
  if (registeredDom) {
    await GlobalRegistrator.unregister();
  }
});

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("desktop font zoom persistence and synchronization", () => {
  test("restores stored zoom immediately on startup and steps cleanly on shortcuts", async () => {
    const storage = createMemoryStorage({ [FONT_ZOOM_STORAGE_KEY]: "1.3" });
    let actualZoom = 1;
    const appliedZooms: number[] = [];

    const detach = attachDesktopFontZoomBehavior({
      targetWindow: window,
      targetDocument: document,
      storage,
      rootStyle: document.documentElement.style,
      isDesktop: () => true,
      getZoomFactor: () => actualZoom,
      setZoomFactor: async (factor) => {
        actualZoom = factor;
        appliedZooms.push(factor);
        return true;
      },
    });

    expect(appliedZooms).toEqual([1.3]);
    expect(actualZoom).toBe(1.3);

    // Unchanged zoom across hashchange or focus should not trigger redundant IPC.
    window.dispatchEvent(new Event("hashchange"));
    window.dispatchEvent(new Event("focus"));
    expect(appliedZooms).toEqual([1.3]);

    // If Chromium resets zoom to 1.0 across a file:// #hash route transition,
    // hashchange/focus restores the stored zoom without waiting for Cmd+/Cmd-.
    actualZoom = 1;
    window.dispatchEvent(new Event("hashchange"));
    expect(appliedZooms).toEqual([1.3, 1.3]);
    expect(actualZoom).toBe(1.3);

    // Native menu zoom actions step from the restored zoom and persist.
    window.dispatchEvent(new CustomEvent("omnirush:native-menu:zoom", { detail: "in" }));
    expect(appliedZooms).toEqual([1.3, 1.3, 1.4]);
    expect(storage.getItem(FONT_ZOOM_STORAGE_KEY)).toBe("1.4");

    window.dispatchEvent(new CustomEvent("omnirush:native-menu:zoom", { detail: "reset" }));
    expect(appliedZooms).toEqual([1.3, 1.3, 1.4, 1]);
    expect(storage.getItem(FONT_ZOOM_STORAGE_KEY)).toBe("1");

    detach?.();
  });

  test("setDesktopZoomFactor applies preload webFrame zoom synchronously alongside main IPC", async () => {
    const order: string[] = [];
    let currentFactor = 1;

    window.__OMNIRUSH_ELECTRON__ = {
      zoom: {
        getFactor: () => currentFactor,
        setFactor: (factor: number) => {
          currentFactor = factor;
          order.push(`preload:${factor}`);
          return true;
        },
      },
      invokeDesktop: (async (command: string, factor: number) => {
        order.push(`main:${command}:${factor}`);
        return true;
      }) as NonNullable<Window["__OMNIRUSH_ELECTRON__"]>["invokeDesktop"],
    };

    const ok = await setDesktopZoomFactor(1.2);
    expect(ok).toBe(true);
    expect(getDesktopZoomFactor()).toBe(1.2);
    expect(order).toEqual(["preload:1.2", "main:__setZoomFactor:1.2"]);
  });
});
