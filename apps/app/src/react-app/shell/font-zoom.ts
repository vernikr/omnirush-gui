/** @jsxImportSource react */
import { useEffect } from "react";

import {
  FONT_ZOOM_STEP,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "../../app/lib/font-zoom";
import { getDesktopZoomFactor, setDesktopZoomFactor } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

const NATIVE_MENU_ZOOM_EVENT = "omnirush:native-menu:zoom";

export type DesktopFontZoomDeps = {
  targetWindow?: Window;
  targetDocument?: Document;
  storage?: Pick<Storage, "getItem" | "setItem">;
  rootStyle?: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
  isDesktop?: () => boolean;
  getZoomFactor?: () => number | null;
  setZoomFactor?: (value: number) => Promise<boolean>;
};

export function attachDesktopFontZoomBehavior(deps: DesktopFontZoomDeps = {}): (() => void) | undefined {
  const targetWindow = deps.targetWindow ?? (typeof window !== "undefined" ? window : undefined);
  if (!targetWindow) return undefined;
  const isDesktop = deps.isDesktop ?? isDesktopRuntime;
  if (!isDesktop()) return undefined;

  const targetDocument = deps.targetDocument ?? (typeof document !== "undefined" ? document : undefined);
  const storage = deps.storage ?? targetWindow.localStorage;
  const rootStyle = deps.rootStyle ?? targetDocument?.documentElement?.style;
  const getZoomFactor = deps.getZoomFactor ?? getDesktopZoomFactor;
  const setZoomFactor = deps.setZoomFactor ?? setDesktopZoomFactor;

  const pushFontZoom = (next: number) => {
    void setZoomFactor(next)
      .then((applied) => {
        if (!rootStyle) return;
        if (applied) {
          rootStyle.removeProperty("--omnirush-font-size");
          return;
        }
        applyFontZoom(rootStyle, next);
      })
      .catch(() => {
        if (rootStyle) {
          applyFontZoom(rootStyle, next);
        }
      });
  };

  const applyAndPersistFontZoom = (value: number) => {
    const next = normalizeFontZoom(value);
    persistFontZoom(storage, next);
    pushFontZoom(next);
    return next;
  };

  let fontZoom = applyAndPersistFontZoom(readStoredFontZoom(storage) ?? 1);

  // Guard against Chromium/Electron resetting page zoom to 1.0 across file://
  // hash-route transitions, hidden-window reveal, or display/focus changes.
  const syncFontZoomIfDrifted = () => {
    const actual = getZoomFactor();
    if (actual !== null && Math.abs(actual - fontZoom) <= 1e-3) {
      return;
    }
    pushFontZoom(fontZoom);
  };

  const handleVisibilityChange = () => {
    if (!targetDocument || targetDocument.visibilityState === "visible") {
      syncFontZoomIfDrifted();
    }
  };

  const applyZoomAction = (action: "in" | "out" | "reset") => {
    if (action === "in") {
      fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
    } else if (action === "out") {
      fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
    } else {
      fontZoom = applyAndPersistFontZoom(1);
    }
  };

  const handleZoomShortcut = (event: KeyboardEvent) => {
    const action = parseFontZoomShortcut(event);
    if (!action) return;

    applyZoomAction(action);

    event.preventDefault();
    event.stopPropagation();
  };

  // Native menu zoom items (View > Zoom In/Out/Actual Size) route through the
  // same pathway so app zoom always stays consistent and persisted.
  const handleNativeMenuZoom = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (detail === "in" || detail === "out" || detail === "reset") {
      applyZoomAction(detail);
    }
  };

  targetWindow.addEventListener("keydown", handleZoomShortcut, true);
  targetWindow.addEventListener(NATIVE_MENU_ZOOM_EVENT, handleNativeMenuZoom);
  targetWindow.addEventListener("hashchange", syncFontZoomIfDrifted);
  targetWindow.addEventListener("popstate", syncFontZoomIfDrifted);
  targetWindow.addEventListener("focus", syncFontZoomIfDrifted);
  targetWindow.addEventListener("pageshow", syncFontZoomIfDrifted);
  targetWindow.addEventListener("resize", syncFontZoomIfDrifted);
  targetDocument?.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    targetWindow.removeEventListener("keydown", handleZoomShortcut, true);
    targetWindow.removeEventListener(NATIVE_MENU_ZOOM_EVENT, handleNativeMenuZoom);
    targetWindow.removeEventListener("hashchange", syncFontZoomIfDrifted);
    targetWindow.removeEventListener("popstate", syncFontZoomIfDrifted);
    targetWindow.removeEventListener("focus", syncFontZoomIfDrifted);
    targetWindow.removeEventListener("pageshow", syncFontZoomIfDrifted);
    targetWindow.removeEventListener("resize", syncFontZoomIfDrifted);
    targetDocument?.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

export function useDesktopFontZoomBehavior() {
  useEffect(() => attachDesktopFontZoomBehavior(), []);
}
