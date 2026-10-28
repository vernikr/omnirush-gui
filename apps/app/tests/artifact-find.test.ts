import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { captureArtifactFindShortcut, findMatchOffsets, findTextRanges } from "../src/react-app/domains/session/artifacts/artifact-find";

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}

test("Find in the focused artifact panel preempts the chat Find shortcut", () => {
  const panel = document.createElement("div");
  panel.dataset.artifactPanel = "";
  const target = document.createElement("button");
  panel.append(target);
  document.body.append(panel);
  let artifactOpens = 0;
  let chatOpens = 0;
  const artifactShortcut = (event: KeyboardEvent) => {
    captureArtifactFindShortcut(event, panel, true, () => { artifactOpens += 1; });
  };
  const chatShortcut = () => { chatOpens += 1; };
  window.addEventListener("keydown", artifactShortcut, true);
  window.addEventListener("keydown", chatShortcut);
  try {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }));
    expect(artifactOpens).toBe(1);
    expect(chatOpens).toBe(0);
  } finally {
    window.removeEventListener("keydown", artifactShortcut, true);
    window.removeEventListener("keydown", chatShortcut);
    panel.remove();
  }
});

test("finds case-insensitive occurrences and reports their offsets", () => {
  expect(findMatchOffsets("Intro TARGET, target. end", "target")).toEqual([
    { start: 6, end: 12 },
    { start: 14, end: 20 },
  ]);
});

test("returns no matches for a blank query or absent text", () => {
  expect(findMatchOffsets("some text", "   ")).toEqual([]);
  expect(findMatchOffsets("some text", "missing")).toEqual([]);
});

test("creates a DOM range for text split across inline Markdown nodes", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>Keep <strong>searching</strong> here.</p><button>searching</button>";
  const matches = findTextRanges(root, "keep searching");
  expect(matches).toHaveLength(1);
  expect(matches[0]?.toString()).toBe("Keep searching");
});
