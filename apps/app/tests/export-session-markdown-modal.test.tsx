/** @jsxImportSource react */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type { ExportableSessionTree } from "../src/app/lib/session-markdown-export";
import { buildCanonicalTranscriptIR } from "../src/app/lib/session-markdown-export";

let savedPayloads: Array<{ filename: string; content: string }> = [];

const realRuntimeEnv = await import("../src/app/lib/runtime-env");

mock.module("@/app/lib/runtime-env", () => ({
  ...realRuntimeEnv,
  isDesktopRuntime: () => false,
}));

mock.module("@/app/lib/download", () => ({
  downloadTextAsFile: (filename: string, content: string) => {
    savedPayloads.push({ filename, content });
  },
}));

mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: () => {},
    error: () => {},
  },
}));

function makeModalFixtureTree(): ExportableSessionTree {
  const session: Session = {
    id: "ses_modal_test",
    slug: "modal-export-test",
    projectID: "proj_1",
    directory: "/workspace/app",
    title: "Modal Export Test",
    version: "0.0.1",
    time: {
      created: Date.UTC(2026, 9, 30, 12, 0, 0),
      updated: Date.UTC(2026, 9, 30, 12, 5, 0),
    },
  };

  const userInfo: Message = {
    id: "msg_u1",
    sessionID: session.id,
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 12, 0, 5) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  } as unknown as Message;

  const userPart: Part = {
    id: "prt_u1",
    sessionID: session.id,
    messageID: "msg_u1",
    type: "text",
    text: "Inspect config.ts twice and run the unit test suite.",
  } as unknown as Part;

  const fileLines = Array.from(
    { length: 70 },
    (_, i) => `${i + 1}: export const SETTING_${i + 1} = "value_${i + 1}_padding_for_dedup";`,
  ).join("\n");
  const readOutput = `<path>/workspace/app/src/config.ts</path>\n<type>file</type>\n<content>${fileLines}\n</content>`;

  const passingTestLines = Array.from(
    { length: 45 },
    (_, i) => `✓ tests/unit-${i + 1}.test.ts > verifies behavior #${i + 1} [2.00ms]`,
  ).join("\n");
  const testOutput = `${passingTestLines}\n\n 45 pass\n 0 fail\nRan 45 tests across 45 files. [120.00ms]`;

  const assistantInfo: Message = {
    id: "msg_a1",
    sessionID: session.id,
    role: "assistant",
    parentID: "msg_u1",
    time: {
      created: Date.UTC(2026, 9, 30, 12, 0, 10),
      completed: Date.UTC(2026, 9, 30, 12, 1, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace/app", root: "/workspace/app" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as Message;

  const assistantParts: Part[] = [
    {
      id: "prt_r1",
      sessionID: session.id,
      messageID: "msg_a1",
      type: "reasoning",
      text: "Let me inspect src/config.ts carefully before running tests. ".repeat(8),
      time: { start: 1, end: 2 },
    } as unknown as Part,
    {
      id: "prt_t1",
      sessionID: session.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_read_1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/app/src/config.ts" },
        output: readOutput,
        title: "src/config.ts",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as unknown as Part,
    {
      id: "prt_t2",
      sessionID: session.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_read_2",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/app/src/config.ts" },
        output: readOutput,
        title: "src/config.ts",
        metadata: {},
        time: { start: 3, end: 4 },
      },
    } as unknown as Part,
    {
      id: "prt_t3",
      sessionID: session.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_bash_tests",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun test" },
        output: testOutput,
        title: "bun test",
        metadata: { exit: 0 },
        time: { start: 5, end: 6 },
      },
    } as unknown as Part,
    {
      id: "prt_txt_final",
      sessionID: session.id,
      messageID: "msg_a1",
      type: "text",
      text: "All 45 tests pass and `src/config.ts` needs no changes.",
    } as unknown as Part,
  ];

  return {
    session,
    messages: [
      { info: userInfo, parts: [userPart] },
      { info: assistantInfo, parts: assistantParts },
    ],
    todos: [],
  };
}

const fixtureTree = makeModalFixtureTree();
const realV2Adapter = await import("../src/app/lib/opencode-v2-adapter");

mock.module("@/app/lib/opencode-v2-adapter", () => ({
  ...realV2Adapter,
  createClientV2: () => ({
    session: {
      get: async () => ({ data: fixtureTree.session }),
      messages: async () => ({ data: fixtureTree.messages }),
      todo: async () => ({ data: [] }),
    },
  }),
}));

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("ExportSessionMarkdownModal (Stage 3)", () => {
  beforeAll(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    GlobalRegistrator.register();
  });

  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("formats byte sizes and estimated token counts deterministically", async () => {
    const { formatEstimatedTokenCount, formatExportByteSize } = await import(
      "../src/react-app/domains/session/commands/export-session-markdown"
    );

    expect(formatExportByteSize(0)).toBe("0 B");
    expect(formatExportByteSize(512)).toBe("512 B");
    expect(formatExportByteSize(2048)).toBe("2.0 KB");
    expect(formatExportByteSize(146_227)).toBe("142.8 KB");
    expect(formatExportByteSize(1_572_864)).toBe("1.50 MB");

    expect(formatEstimatedTokenCount(420)).toBe("420");
    expect(formatEstimatedTokenCount(12_460)).toBe("12.5k");
    expect(formatEstimatedTokenCount(1_250_000)).toBe("1.25M");
  });

  test("opens with all 3 checkboxes enabled + lossless default, updates live file size on every toggle, has no filename/copy controls, and exports selected variant", async () => {
    savedPayloads = [];
    const { renderTranscriptFromIR } = await import("../src/app/lib/session-markdown-export");
    const { ExportSessionMarkdownModal } = await import(
      "../src/react-app/domains/session/commands/export-session-markdown-modal"
    );
    const { formatExportByteSize } = await import(
      "../src/react-app/domains/session/commands/export-session-markdown"
    );
    const { closeExportMarkdownModal, openExportMarkdownModal, useExportSessionMarkdownStore } =
      await import("../src/react-app/domains/session/commands/export-session-markdown-store");

    const ir = buildCanonicalTranscriptIR(fixtureTree);
    const expectedLossless = renderTranscriptFromIR(ir, {
      includeToolCalls: true,
      includeReasoning: true,
      compression: "lossless",
    });
    const expectedSmart = renderTranscriptFromIR(ir, {
      includeToolCalls: true,
      includeReasoning: true,
      compression: "smart",
    });
    const expectedStubs = renderTranscriptFromIR(ir, {
      includeToolCalls: true,
      includeReasoning: true,
      compression: "stubs",
    });
    const expectedRaw = renderTranscriptFromIR(ir, {
      includeToolCalls: true,
      includeReasoning: true,
      compression: "off",
    });
    const expectedNoTools = renderTranscriptFromIR(ir, {
      includeToolCalls: false,
      includeReasoning: true,
      compression: "stubs",
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<ExportSessionMarkdownModal />);
      });

      await act(async () => {
        openExportMarkdownModal({
          workspaceId: "ws_1",
          sessionId: "ses_modal_test",
          opencodeBaseUrl: "http://127.0.0.1:4096",
          token: "tok",
        });
      });

      await waitFor(
        () => document.querySelector('[data-testid="export-markdown-live-size"]') !== null,
        "live size element",
      );

      const modal = document.querySelector('[data-testid="export-markdown-modal"]');
      expect(modal).not.toBeNull();

      // Strictly NO editable filename input and NO copy-to-clipboard button in the modal.
      expect(modal?.querySelector('input[type="text"]')).toBeNull();
      expect(modal?.textContent?.toLowerCase()).not.toContain("clipboard");

      const toolCallsCheckbox = document.querySelector<HTMLElement>(
        '[data-testid="export-opt-tool-calls"]',
      )!;
      const reasoningCheckbox = document.querySelector<HTMLElement>(
        '[data-testid="export-opt-reasoning"]',
      )!;
      const compressCheckbox = document.querySelector<HTMLElement>(
        '[data-testid="export-opt-compress"]',
      )!;

      // All 3 checkboxes must default to checked.
      expect(toolCallsCheckbox.getAttribute("aria-checked")).toBe("true");
      expect(reasoningCheckbox.getAttribute("aria-checked")).toBe("true");
      expect(compressCheckbox.getAttribute("aria-checked")).toBe("true");

      const losslessBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="export-mode-lossless"]',
      )!;
      const smartBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="export-mode-smart"]',
      )!;
      const stubsBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="export-mode-stubs"]',
      )!;
      expect(losslessBtn.getAttribute("aria-checked")).toBe("true");

      const readSizeText = () =>
        document.querySelector('[data-testid="export-markdown-live-size"]')?.textContent?.trim();

      expect(readSizeText()).toBe(formatExportByteSize(expectedLossless.utf8Bytes));
      expect(
        document.querySelector('[data-testid="export-markdown-live-savings"]')?.textContent,
      ).toContain(formatExportByteSize(expectedRaw.utf8Bytes));

      // Switch to Smart -> live size updates immediately.
      await act(async () => {
        smartBtn.click();
      });
      expect(smartBtn.getAttribute("aria-checked")).toBe("true");
      expect(readSizeText()).toBe(formatExportByteSize(expectedSmart.utf8Bytes));

      // Switch to Compact Stubs -> live size drops further.
      await act(async () => {
        stubsBtn.click();
      });
      expect(stubsBtn.getAttribute("aria-checked")).toBe("true");
      expect(readSizeText()).toBe(formatExportByteSize(expectedStubs.utf8Bytes));

      // Uncheck Compress output -> live size matches uncompressed raw baseline and savings badge disappears.
      await act(async () => {
        compressCheckbox.click();
      });
      expect(compressCheckbox.getAttribute("aria-checked")).toBe("false");
      expect(readSizeText()).toBe(formatExportByteSize(expectedRaw.utf8Bytes));
      expect(document.querySelector('[data-testid="export-markdown-live-savings"]')).toBeNull();

      // Re-check Compress output (still remembers Stubs within same modal open) and uncheck Tool Calls.
      await act(async () => {
        compressCheckbox.click();
      });
      expect(readSizeText()).toBe(formatExportByteSize(expectedStubs.utf8Bytes));

      await act(async () => {
        toolCallsCheckbox.click();
      });
      expect(toolCallsCheckbox.getAttribute("aria-checked")).toBe("false");
      expect(readSizeText()).toBe(formatExportByteSize(expectedNoTools.utf8Bytes));

      // Re-enable Tool Calls and uncheck Reasoning by clicking its label, then export!
      const reasoningLabel = document.querySelector<HTMLLabelElement>(
        'label[for="export-opt-reasoning-input"]',
      )!;
      await act(async () => {
        toolCallsCheckbox.click();
        reasoningLabel.click();
      });
      expect(toolCallsCheckbox.getAttribute("aria-checked")).toBe("true");
      expect(reasoningCheckbox.getAttribute("aria-checked")).toBe("false");

      const confirmBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="export-markdown-confirm"]',
      )!;
      await act(async () => {
        confirmBtn.click();
      });

      await waitFor(
        () => useExportSessionMarkdownStore.getState().activeTarget === null,
        "modal close after export",
      );

      expect(savedPayloads.length).toBe(1);
      expect(savedPayloads[0]!.filename).toBe("Modal-Export-Test-modal_test.md");
      expect(savedPayloads[0]!.content).not.toContain("> _Reasoning_");
      expect(savedPayloads[0]!.content).toContain("- **Omitted:** reasoning");
      expect(savedPayloads[0]!.content).toContain("- **Compression:** `stubs`");

      // Re-opening the modal resets all 3 checkboxes back to true + lossless default.
      await act(async () => {
        openExportMarkdownModal({
          workspaceId: "ws_1",
          sessionId: "ses_modal_test",
          opencodeBaseUrl: "http://127.0.0.1:4096",
          token: "tok",
        });
      });
      await waitFor(
        () => document.querySelector('[data-testid="export-opt-reasoning"]') !== null,
        "reopened modal controls",
      );
      expect(
        document
          .querySelector('[data-testid="export-opt-reasoning"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        document
          .querySelector('[data-testid="export-mode-lossless"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");

      await act(async () => {
        closeExportMarkdownModal();
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  });
});
