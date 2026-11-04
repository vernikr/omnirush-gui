/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
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
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const { LexicalPromptEditor } = await import("../src/react-app/domains/session/surface/composer/editor");

test("Expand updates only the selected chip, including after an external edit", async () => {
  const quote = { label: "Quote: quoted", text: "> quoted", lines: 1 };
  const other = { label: "Quote: other", text: "> other", lines: 1 };
  const paste = { label: "plain", text: "one\ntwo\tthree", lines: 2 };
  const q = `[pasted text ${quote.label}]`;
  const o = `[pasted text ${other.label}]`;
  const p = `[pasted text ${paste.label}]`;
  const cases = [
    { initial: `${q}after`, edit: `before${q}after`, parts: [quote], click: 0, expected: "before\n\n> quoted\n\nafter", remaining: 0 },
    { initial: `${q}\nreply`, parts: [quote], click: 0, expected: "> quoted\n\nreply", remaining: 0 },
    { initial: `${q} and ${o} tail`, parts: [quote, other], click: 1, expected: `${q} and \n\n> other\n\n tail`, remaining: 1 },
    { initial: `before${p}after`, parts: [paste], click: 0, expected: "beforeone\ntwo\tthreeafter", remaining: 0 },
  ];
  {
    for (const example of cases) {
      let observed = "";
      let edit = (_value: string) => {};
      let expansions = 0;
      let changes = 0;
      function TestEditor() {
        const [value, setValue] = useState(example.initial);
        observed = value;
        edit = setValue;
        return <LexicalPromptEditor value={value} mentions={{}} pastedText={example.parts} submitDisabled={false} placeholder="Message"
          onChange={(next) => { changes += 1; setValue(next); }} onSubmit={() => {}}
          onExpandPastedText={(_label, draft) => { expansions += 1; setValue(draft); }} />;
      }
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => { root.render(<TestEditor />); });
        if (example.edit) await act(async () => { edit(example.edit!); });
        const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Expand pasted text in composer"]');
        expect(buttons.length).toBe(example.parts.length);
        await act(async () => { buttons[example.click]?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
        expect(observed).toBe(example.expected);
        expect(expansions).toBe(1);
        expect(changes).toBe(0);
        expect(container.querySelectorAll('button[aria-label="Expand pasted text in composer"]').length).toBe(example.remaining);
      } finally {
        await act(async () => { root.unmount(); });
        container.remove();
      }
    }
  }
});
