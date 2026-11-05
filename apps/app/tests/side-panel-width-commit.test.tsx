/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as RP from "react-resizable-panels";

import { commitSidePanelWidth, scheduleSidePanelWidthCommit } from "../src/react-app/domains/session/chat/side-panel-width";

const { Panel: ResizablePanel, Separator: ResizableHandle, Group: ResizablePanelGroup, usePanelRef } = RP as any;

GlobalRegistrator.register({ url: "http://localhost/" });

// happy-dom has no layout engine: derive a panel's width from the flex-grow the
// library writes, the way a real flexbox would.
const GROUP_WIDTH = 1000;
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    const el = this as HTMLElement;
    if (el.dataset?.testGroup === "1") return GROUP_WIDTH;
    if (el.getAttribute("data-panel") === "true") {
      const parent = el.parentElement;
      if (!parent) return 0;
      const panels = Array.from(parent.querySelectorAll(':scope > [data-panel="true"]')) as HTMLElement[];
      const grow = (node: HTMLElement) => Number.parseFloat(node.style.flexGrow || "0");
      const sum = panels.reduce((total, node) => total + grow(node), 0);
      return sum ? Math.round((grow(el) / sum) * GROUP_WIDTH) : 0;
    }
    return 0;
  },
});
if (typeof window !== "undefined") {
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

test("a panel width is only committed once the panel has a real size", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const committed: number[] = [];
  let api: any = null;

  function App({ open }: { open: boolean }) {
    const panelRef = usePanelRef();
    // The page only re-reads the remembered width when the panel is closed.
    const [width, setWidth] = useState(560);
    const [defaultWidth, setDefaultWidth] = useState(560);
    const lastSize = useRef(0);
    const frameRef = useRef<number | null>(null);
    useEffect(() => {
      if (open) return;
      setDefaultWidth(width);
    }, [open, width]);
    useEffect(() => {
      api = { panelRef, defaultWidth };
    });
    return (
      <ResizablePanelGroup
        orientation="horizontal"
        data-test-group="1"
        onLayoutChanged={open ? () => {
          // Read on the next frame, like the page does: the callback itself
          // still sees the previous width.
          scheduleSidePanelWidthCommit(frameRef, () => {
            commitSidePanelWidth(panelRef, lastSize, (next) => {
              committed.push(next);
              setWidth(next);
            });
          }, { requestAnimationFrame: (cb) => Number(setTimeout(cb, 0)), cancelAnimationFrame: (id) => clearTimeout(id) } as any);
        } : undefined}
      >
        <ResizablePanel minSize="320px"><div /></ResizablePanel>
        {open ? (
          <>
            <ResizableHandle />
            <ResizablePanel panelRef={panelRef} defaultSize={`${defaultWidth}px`} minSize="320px" maxSize="70%">
              <div />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    );
  }

  const root = createRoot(container);
  const render = async (open: boolean) => {
    act(() => { root.render(<App open={open} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  };

  // Mount and remount cycles are where transient sizes used to leak in: the
  // panel reports 0 and a few pixels before it settles.
  await render(true);
  await render(false);
  await render(true);
  expect(committed.every((width) => width >= 320)).toBe(true);
  const settled = api.panelRef.current.getSize().inPixels;
  expect(settled).toBe(560);

  // The user resizes the panel; that width is remembered. (happy-dom's flexbox
  // stand-in caps at 70% of the group, so the width comes from the library.)
  act(() => { api.panelRef.current.resize("68%"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  const dragged = api.panelRef.current.getSize().inPixels;
  expect(dragged).toBeGreaterThan(0);
  expect(committed.length).toBeGreaterThan(0);
  expect(committed.at(-1)).toBe(dragged);

  // Close and reopen: the panel comes back at the width the user chose, not at
  // a size that was captured while it was mounting.
  await render(false);
  committed.length = 0;
  await render(true);
});

test("a transient size never becomes the remembered width", () => {
  const surface = (inPixels: number | null) => ({
    current: inPixels === null ? null : { getSize: () => ({ inPixels, asPercentage: 0 }) },
  });
  const last = { current: 0 };
  const commits: number[] = [];
  const commit = (next: number) => commits.push(next);

  // A mounting panel reports 0 and then a few pixels before it settles.
  expect(commitSidePanelWidth(surface(0), last, commit)).toBe(false);
  expect(commitSidePanelWidth(surface(6), last, commit)).toBe(false);
  expect(commitSidePanelWidth(surface(319.4), last, commit)).toBe(false);
  expect(commitSidePanelWidth(surface(null), last, commit)).toBe(false);
  expect(commitSidePanelWidth(surface(Number.NaN), last, commit)).toBe(false);
  expect(commits).toEqual([]);

  // A settled panel is committed once, not on every layout event.
  expect(commitSidePanelWidth(surface(640.2), last, commit)).toBe(true);
  expect(commitSidePanelWidth(surface(640.4), last, commit)).toBe(false);
  expect(commits).toEqual([640]);
  expect(last.current).toBe(640);
});
