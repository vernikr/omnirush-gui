/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
for (const moduleId of [
  "lexical", "@lexical/react/LexicalComposer.js", "@lexical/react/LexicalPlainTextPlugin.js",
  "@lexical/react/LexicalContentEditable.js", "@lexical/react/LexicalErrorBoundary.js",
  "@lexical/react/LexicalOnChangePlugin.js", "@lexical/react/LexicalHistoryPlugin.js",
  "@lexical/react/LexicalComposerContext.js",
]) {
  const exports = require(moduleId);
  mock.module(moduleId, () => exports);
}
const registered = !globalThis.document;
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
const { LexicalPromptEditor } = await import("../src/react-app/domains/session/surface/composer/editor");
const { replacePastedTextPlaceholder } = await import("../src/react-app/domains/session/surface/composer/pasted-text");

test("Expand replaces a quote with text on both sides without losing either", async () => {
  const part = { label: "Quote: quoted", text: "> quoted", lines: 1 };
  let observed = "";
  function TestEditor() {
    const [value, setValue] = useState(`before[pasted text ${part.label}]after`);
    const [chips, setChips] = useState([part]);
    observed = value;
    return <LexicalPromptEditor value={value} mentions={{}} pastedText={chips} submitDisabled={false} placeholder="Message"
      onChange={setValue} onSubmit={() => {}} onExpandPastedText={() => {
        setValue((draft) => replacePastedTextPlaceholder(draft, part));
        setChips([]);
      }} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TestEditor />); });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Expand pasted text in composer"]');
    expect(button).not.toBeNull();
    await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(observed).toBe("before\n\n> quoted\n\nafter");
    expect(container.querySelector('button[aria-label="Expand pasted text in composer"]')).toBeNull();
    expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain("> quoted");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    if (registered) await GlobalRegistrator.unregister();
  }
});
