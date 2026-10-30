import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk/v2/client";

import {
  buildCanonicalTranscriptIR,
  classifyToolSafety,
  collapsePassingTestRuns,
  compactSearchOutput,
  renderTranscriptFromIR,
  stripAnsiAndProgressNoise,
  type ExportableSessionMessage,
  type ExportableSessionTree,
} from "../src/app/lib/session-markdown-export";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_stage2_01",
    slug: "smart-stubs",
    projectID: "proj_1",
    directory: "/workspace/omnirush-gui",
    title: "Smart and Stubs Compression",
    version: "2.0.0",
    time: {
      created: Date.UTC(2026, 9, 30, 11, 0, 0),
      updated: Date.UTC(2026, 9, 30, 11, 30, 0),
    },
    ...overrides,
  };
}

function makeUser(id: string, text: string): ExportableSessionMessage {
  const info: UserMessage = {
    id,
    sessionID: "ses_stage2_01",
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 11, 0, 0) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  };
  return {
    info,
    parts: [{ id: `${id}_p1`, sessionID: "ses_stage2_01", messageID: id, type: "text", text }],
  };
}

function makeAssistant(id: string, parentID: string, parts: Part[]): ExportableSessionMessage {
  const info: AssistantMessage = {
    id,
    sessionID: "ses_stage2_01",
    role: "assistant",
    parentID,
    time: {
      created: Date.UTC(2026, 9, 30, 11, 1, 0),
      completed: Date.UTC(2026, 9, 30, 11, 2, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace/omnirush-gui", root: "/workspace/omnirush-gui" },
    cost: 0.015,
    tokens: {
      input: 1500,
      output: 500,
      reasoning: 250,
      cache: { read: 0, write: 0 },
    },
  };
  return { info, parts };
}

function makeV2ReadOutput(filePath: string, lines: string[], startLine = 1): string {
  const numbered = lines.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${numbered}\n\n(End of file - total ${startLine + lines.length - 1} lines)\n</content>`;
}

describe("markdown-export Stage 2 Safety Router, Smart CLI, and Compact Stubs", () => {
  test("stripAnsiAndProgressNoise and collapsePassingTestRuns clean CLI noise while preserving 100% of test failures", () => {
    const rawSpinner =
      "⠋ Building...\n\x1b[36mDownloading 10%\x1b[0m\r\x1b[36mDownloading 60%\x1b[0m\r\x1b[32mDownload complete\x1b[0m\n";
    expect(stripAnsiAndProgressNoise(rawSpinner)).toBe("Download complete");

    const mixedSuite = [
      "bun test v1.3.14",
      ...Array.from({ length: 24 }, (_, idx) => `(pass) auth > case #${idx + 1} [0.42ms]`),
      "(fail) auth > rejects expired token [3.10ms]",
      "error: expect(received).toBe(expected)",
      "Expected: 401",
      "Received: 200",
      "      at <anonymous> (/workspace/omnirush-gui/tests/auth.test.ts:88:14)",
      ...Array.from({ length: 12 }, (_, idx) => `  ✓ vitest suite > check #${idx + 1} (2 ms)`),
      " 24 pass",
      " 1 fail",
    ].join("\n");

    const collapsed = collapsePassingTestRuns(mixedSuite);
    expect(collapsed.collapsedLines).toBe(36);
    expect(collapsed.text).toContain("[... collapsed 24 passing test lines ...]");
    expect(collapsed.text).toContain("[... collapsed 12 passing test lines ...]");
    expect(collapsed.text).toContain("(fail) auth > rejects expired token [3.10ms]");
    expect(collapsed.text).toContain("Expected: 401");
    expect(collapsed.text).toContain("Received: 200");
    expect(collapsed.text).toContain("at <anonymous> (/workspace/omnirush-gui/tests/auth.test.ts:88:14)");
    expect(collapsed.text).toContain(" 1 fail");
  });

  test("Safety Router strictly protects errors, stack traces, compiler errors, non-zero exits, PEM keys, SQL migrations, and mutating tools in both Smart and Stubs", () => {
    const longStackLines = [
      ...Array.from({ length: 140 }, (_, i) => `step ${i + 1}: initializing worker context padding_text_for_size_threshold`),
      "TypeError: Cannot read properties of undefined (reading 'session')",
      "    at runWorker (/workspace/omnirush-gui/src/worker.ts:142:19)",
      ...Array.from({ length: 30 }, (_, i) => `cleanup line ${i + 1}: releasing handle`),
    ].join("\n");

    const sqlMigrationLines = [
      "-- Initial schema migration",
      "BEGIN TRANSACTION;",
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL);",
      ...Array.from({ length: 45 }, (_, i) => `ALTER TABLE sessions ADD COLUMN col_${i + 1} TEXT;`),
      "COMMIT;",
    ];

    const pemLines = [
      "-----BEGIN PUBLIC KEY-----",
      ...Array.from({ length: 35 }, () => "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7V1234567890ABCDEF"),
      "-----END PUBLIC KEY-----",
    ];

    const tsErrorOutput = [
      ...Array.from({ length: 130 }, (_, i) => `checking module_${i + 1}.ts ... ok_padding_line_for_threshold_check`),
      "src/broken.ts(29,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");

    const tree: ExportableSessionTree = {
      session: makeSession(),
      messages: [
        makeUser("u1", "Run diagnostics and inspect migration + cert."),
        makeAssistant("a1", "u1", [
          {
            id: "r1",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "reasoning",
            text: "CRITICAL_REASONING_TEXT_MUST_NEVER_BE_TRUNCATED",
            time: { start: 1, end: 2 },
          },
          // 1. Completed status, but contains V8 stack trace in output
          {
            id: "t_stack",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_stack",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "node worker.js" },
              output: longStackLines,
              title: "Run worker",
              metadata: { exitCode: 0 },
              time: { start: 2, end: 3 },
            },
          },
          // 2. TypeScript compiler diagnostic error
          {
            id: "t_tsc",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_tsc",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "tsc --noEmit" },
              output: tsErrorOutput,
              title: "Typecheck",
              metadata: { exitCode: 2 },
              time: { start: 3, end: 4 },
            },
          },
          // 3. SQL migration opened via Read (must NOT be stubbed even though unmodified!)
          {
            id: "t_sql",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_sql",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "migrations/0001_init.sql" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/migrations/0001_init.sql", sqlMigrationLines),
              title: "migrations/0001_init.sql",
              metadata: {},
              time: { start: 4, end: 5 },
            },
          },
          // 4. PEM file opened via Read (must NOT be stubbed!)
          {
            id: "t_pem",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_pem",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "certs/pub.pem" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/certs/pub.pem", pemLines),
              title: "certs/pub.pem",
              metadata: {},
              time: { start: 5, end: 6 },
            },
          },
          // 5. Explicit error status tool call
          {
            id: "t_err",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_err",
            tool: "grep",
            state: {
              status: "error",
              input: { pattern: "foo" },
              error: "ripgrep failed with exit status 2",
              metadata: {
                output: Array.from({ length: 60 }, (_, i) => `partial_err_line_${i + 1}`).join("\n"),
              },
              time: { start: 6, end: 7 },
            },
          },
          // 6. Mutating Edit tool call
          {
            id: "t_edit",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "tool",
            callID: "c_edit",
            tool: "edit",
            state: {
              status: "completed",
              input: { filePath: "src/app.ts", oldString: "a = 1", newString: "a = 2" },
              output: "Applied edit to src/app.ts",
              title: "src/app.ts",
              metadata: {},
              time: { start: 7, end: 8 },
            },
          },
          {
            id: "txt1",
            sessionID: "ses_stage2_01",
            messageID: "a1",
            type: "text",
            text: "ASSISTANT_FINAL_ANSWER_INTACT",
          },
        ]),
      ],
    };

    const ir = buildCanonicalTranscriptIR(tree);
    const toolParts = ir.root.messages[1]!.parts.filter((p) => p.kind === "tool");
    for (const tp of toolParts) {
      if (tp.kind === "tool") {
        expect(classifyToolSafety(tp).bypassLossy).toBe(true);
      }
    }

    for (const mode of ["smart", "stubs"] as const) {
      const res = renderTranscriptFromIR(ir, {
        includeToolCalls: true,
        includeReasoning: true,
        compression: mode,
      });

      // Every single protected line and middle line of stack/tsc/sql/pem/error/edit is preserved!
      expect(res.markdown).toContain("CRITICAL_REASONING_TEXT_MUST_NEVER_BE_TRUNCATED");
      expect(res.markdown).toContain("ASSISTANT_FINAL_ANSWER_INTACT");
      expect(res.markdown).toContain("step 75: initializing worker context");
      expect(res.markdown).toContain("TypeError: Cannot read properties of undefined (reading 'session')");
      expect(res.markdown).toContain("at runWorker (/workspace/omnirush-gui/src/worker.ts:142:19)");
      expect(res.markdown).toContain("checking module_75.ts");
      expect(res.markdown).toContain("src/broken.ts(29,7): error TS2322:");
      expect(res.markdown).toContain("ALTER TABLE sessions ADD COLUMN col_40 TEXT;");
      expect(res.markdown).toContain("-----BEGIN PUBLIC KEY-----");
      expect(res.markdown).toContain("partial_err_line_55");
      expect(res.markdown).toContain("ripgrep failed with exit status 2");
      expect(res.markdown).toContain("Applied edit to src/app.ts");
      expect(res.markdown).not.toContain("[... omitted ");
      expect(res.markdown).not.toContain("[Stubbed ");
    }
  });

  test("achieves strict size hierarchy (stubs < smart < lossless < off), deduplicates post-ANSI Bash outputs, and keeps latest snapshot of edited files in Stubs", () => {
    const untouchedLines = Array.from(
      { length: 65 },
      (_, idx) => `export const untouchedHelper_${idx + 1} = () => "exploratory_only_${idx + 1}";`,
    );
    const initialEditedLines = Array.from(
      { length: 55 },
      (_, idx) => `export const serviceLine_${idx + 1} = "v1_value_${idx + 1}";`,
    );
    const finalEditedLines = [...initialEditedLines];
    finalEditedLines[19] = 'export const serviceLine_20 = "FINAL_UPDATED_V2_VALUE";';

    const cleanVerboseBuild = Array.from(
      { length: 160 },
      (_, idx) => `[build] Bundled module chunk_${String(idx + 1).padStart(3, "0")}.js (14.2 KB) in 3ms`,
    ).join("\n");

    const suiteSummaryFooter = [
      "Test Suites: 6 passed, 6 total (auth, session, export, router, ipc, markdown)",
      "Tests:       30 passed, 30 total",
      "Snapshots:   4 passed, 4 total",
      "Coverage:    statements 94.2%, branches 89.7%, functions 96.1%, lines 94.5%",
      "Ran 30 tests across 6 files in 412.00ms.",
    ].join("\n");

    const ansiTestRun1 = [
      "⠋ Running tests...",
      "\x1b[32mbun test v1.3.14\x1b[0m",
      ...Array.from({ length: 30 }, (_, i) => `\x1b[32m(pass)\x1b[0m suite > spec_${i + 1} [1.00ms]`),
      suiteSummaryFooter,
    ].join("\n");

    // Second run has different progress spinner frames, but identical semantic output after Smart normalization!
    const ansiTestRun2 = [
      "⠙ Running tests...\r⠸ Running tests...\r",
      "⠹ Compiling test bundle...",
      "\x1b[32mbun test v1.3.14\x1b[0m",
      ...Array.from({ length: 30 }, (_, i) => `(pass) suite > spec_${i + 1} [1.00ms]`),
      suiteSummaryFooter,
    ].join("\n");

    const bulkyGlob = Array.from(
      { length: 42 },
      (_, i) => `/workspace/omnirush-gui/apps/app/src/components/icons/icon-${String(i + 1).padStart(2, "0")}.tsx`,
    ).join("\n");

    const tree: ExportableSessionTree = {
      session: makeSession(),
      messages: [
        makeUser("m1", "Explore codebase, update service.ts, and run build + tests."),
        makeAssistant("m2", "m1", [
          // 1. Exploratory Read of untouched file
          {
            id: "p_untouched",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/untouched.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/untouched.ts", untouchedLines),
              title: "src/untouched.ts",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
          // 2. Bulky Glob exploration
          {
            id: "p_glob",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c2",
            tool: "glob",
            state: {
              status: "completed",
              input: { pattern: "apps/app/src/components/icons/*.tsx" },
              output: bulkyGlob,
              title: "Find icons",
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
          // 3. Initial Read of src/service.ts (will be superseded by Turn 2's post-edit Read)
          {
            id: "p_read_v1",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c3",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/service.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/service.ts", initialEditedLines),
              title: "src/service.ts",
              metadata: {},
              time: { start: 3, end: 4 },
            },
          },
          // 4. Edit src/service.ts
          {
            id: "p_edit",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c4",
            tool: "edit",
            state: {
              status: "completed",
              input: {
                filePath: "src/service.ts",
                oldString: 'serviceLine_20 = "v1_value_20"',
                newString: 'serviceLine_20 = "FINAL_UPDATED_V2_VALUE"',
              },
              output: "Updated src/service.ts",
              title: "src/service.ts",
              metadata: {},
              time: { start: 4, end: 5 },
            },
          },
          // 5. Post-edit Read of src/service.ts (latest snapshot of mutated file!)
          {
            id: "p_read_v2",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c5",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/service.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/service.ts", finalEditedLines),
              title: "src/service.ts",
              metadata: {},
              time: { start: 5, end: 6 },
            },
          },
          // 6. Clean verbose build output (exit 0)
          {
            id: "p_build",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c6",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pnpm build" },
              output: cleanVerboseBuild,
              title: "Build",
              metadata: { exitCode: 0 },
              time: { start: 6, end: 7 },
            },
          },
          // 7. Test run #1 (with ANSI + spinner)
          {
            id: "p_test1",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c7",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "bun test" },
              output: ansiTestRun1,
              title: "Run tests",
              metadata: { exitCode: 0 },
              time: { start: 7, end: 8 },
            },
          },
          // 8. Test run #2 (different spinner frames, identical post-Smart test output!)
          {
            id: "p_test2",
            sessionID: "ses_stage2_01",
            messageID: "m2",
            type: "tool",
            callID: "c8",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "bun test" },
              output: ansiTestRun2,
              title: "Re-run tests",
              metadata: { exitCode: 0 },
              time: { start: 8, end: 9 },
            },
          },
        ]),
      ],
    };

    const ir = buildCanonicalTranscriptIR(tree);
    const rawRes = renderTranscriptFromIR(ir, { compression: "off" });
    const losslessRes = renderTranscriptFromIR(ir, { compression: "lossless" });
    const smartRes = renderTranscriptFromIR(ir, { compression: "smart" });
    const stubsRes = renderTranscriptFromIR(ir, { compression: "stubs" });

    // Strict progressive byte reduction across all 4 modes
    expect(losslessRes.utf8Bytes).toBeLessThan(rawRes.utf8Bytes);
    expect(smartRes.utf8Bytes).toBeLessThan(losslessRes.utf8Bytes);
    expect(stubsRes.utf8Bytes).toBeLessThan(smartRes.utf8Bytes);

    // Smart assertions
    expect(smartRes.markdown).toContain("[... omitted 80 middle lines (exit 0, no errors detected) ...]");
    expect(smartRes.markdown).toContain("[... collapsed 30 passing test lines ...]");
    expect(smartRes.markdown).toContain("[Base directory: /workspace/omnirush-gui/]");
    expect(smartRes.markdown).toContain("[... +37 more files in apps/app/src/components/icons/ ...]");
    // Post-ANSI test run #2 deduplicated against test run #1!
    expect(smartRes.stats.exactDedupCount).toBeGreaterThanOrEqual(1);

    // Stubs assertions: untouched Read & superseded v1 Read & Glob are stubbed, while FINAL_UPDATED_V2_VALUE stays intact!
    expect(stubsRes.stats.stubbedCount).toBe(3);
    expect(stubsRes.markdown).toContain("Stubbed exploratory Read of `/workspace/omnirush-gui/src/untouched.ts`");
    expect(stubsRes.markdown).toContain("Stubbed superseded Read of `/workspace/omnirush-gui/src/service.ts`");
    expect(stubsRes.markdown).toContain("Stubbed exploratory Glob output");
    expect(stubsRes.markdown).toContain("FINAL_UPDATED_V2_VALUE");

    // Helper unit check for grep compaction
    const grepSample = Array.from(
      { length: 45 },
      (_, i) => `/workspace/omnirush-gui/src/big.ts:${i + 1}:const match = ${i};`,
    ).join("\n");
    const grepCompacted = compactSearchOutput("grep", grepSample, "/workspace/omnirush-gui");
    expect(grepCompacted).toContain("[Base directory: /workspace/omnirush-gui/]");
    expect(grepCompacted).toContain("[... +39 more matches in src/big.ts ...]");

    // Zero Russian / Cyrillic characters in either Smart or Stubs output
    expect(/[\u0400-\u04FF]/.test(smartRes.markdown)).toBe(false);
    expect(/[\u0400-\u04FF]/.test(stubsRes.markdown)).toBe(false);
  });
});
