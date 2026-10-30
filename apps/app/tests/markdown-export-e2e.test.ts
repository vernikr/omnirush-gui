import { describe, expect, test } from "bun:test";
import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client";

import {
  buildCanonicalTranscriptIR,
  expandLosslessMarkdown,
  renderTranscriptFromIR,
  verifyLosslessRoundTrip,
  type CompressionMode,
  type ExportableSessionTree,
} from "../src/app/lib/session-markdown-export";

const CYRILLIC_RE = /[\u0400-\u04FF]/;

function makeRealisticMultiTurnSession(): ExportableSessionTree {
  const rootSession: Session = {
    id: "ses_e2e_stage4",
    slug: "e2e-stage4-refactor",
    projectID: "proj_e2e",
    directory: "/workspace/omnirush",
    title: "Refactor Auth Middleware",
    version: "1.0.0",
    revert: {
      messageID: "msg_003_reverted",
    },
    time: {
      created: Date.UTC(2026, 9, 30, 10, 0, 0),
      updated: Date.UTC(2026, 9, 30, 10, 45, 0),
    },
  };

  const childSession: Session = {
    id: "ses_subagent_audit",
    slug: "subagent-security-audit",
    parentID: rootSession.id,
    projectID: "proj_e2e",
    directory: "/workspace/omnirush",
    title: "Security Audit (@audit)",
    version: "1.0.0",
    time: {
      created: Date.UTC(2026, 9, 30, 10, 10, 0),
      updated: Date.UTC(2026, 9, 30, 10, 15, 0),
    },
  };

  // Large exploratory file (never edited in branch -> stubbed in "stubs", deduplicated in "lossless")
  const exploratoryLines = Array.from(
    { length: 90 },
    (_, i) => `export const LEGACY_ROUTE_${i + 1} = "/api/v1/legacy/resource-${i + 1}";`,
  );
  const exploratoryReadV2 = `<path>/workspace/omnirush/src/routes/legacy.ts</path>\n<type>file</type>\n<content>${exploratoryLines
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n")}\n</content>`;

  // Edited target file v1 (before edit) and v2 (after edit -> 1-hop delta in lossless, latest kept in stubs)
  const authBaseLines = Array.from(
    { length: 80 },
    (_, i) => `export function verifyGuard${i + 1}(token: string): boolean { return token.length > ${i + 4}; }`,
  );
  const authReadBefore = `<path>/workspace/omnirush/src/auth/guard.ts</path>\n<type>file</type>\n<content>${authBaseLines
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n")}\n</content>`;

  const authSlice10to25 = `<path>/workspace/omnirush/src/auth/guard.ts</path>\n<type>file</type>\n<content>${authBaseLines
    .slice(9, 25)
    .map((line, idx) => `${idx + 10}: ${line}`)
    .join("\n")}\n</content>`;

  const authEditedLines = [...authBaseLines];
  authEditedLines[11] =
    'export function verifyGuard12(token: string): boolean { return token.startsWith("omni_") && token.length > 24; }';
  authEditedLines[40] =
    "export function verifyGuard41(token: string): boolean { return Boolean(token.trim()) && token.length > 44; }";
  const authReadAfter = `<path>/workspace/omnirush/src/auth/guard.ts</path>\n<type>file</type>\n<content>${authEditedLines
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n")}\n</content>`;

  // Uniform JSON array -> TOON-JSON v1 candidate
  const tabularJson = JSON.stringify(
    Array.from({ length: 24 }, (_, idx) => ({
      id: idx + 1,
      endpoint: `/api/v2/service-${idx + 1}`,
      method: idx % 2 === 0 ? "GET" : "POST",
      authenticated: true,
      timeoutMs: 2500,
    })),
    null,
    2,
  );

  // Failing test run (must NEVER lose error details in Smart or Stubs)
  const failingTestOutput = [
    "\u001b[32m✓\u001b[0m tests/guard-basic.test.ts > accepts valid prefix [1.10ms]",
    "\u001b[31m✗\u001b[0m tests/guard-edge.test.ts > rejects expired session",
    "error: expect(received).toBe(expected)",
    "Expected: false",
    "Received: true",
    "      at verifyGuard12 (/workspace/omnirush/src/auth/guard.ts:12:15)",
    "",
    " 1 pass",
    " 1 fail",
  ].join("\n");

  // Passing test run with ANSI + spinner frames (compacted in Smart & Stubs)
  const passingTestOutput = [
    "⠋ Compiling test bundle...\r✓ Bundle ready",
    ...Array.from(
      { length: 60 },
      (_, idx) => `\u001b[32m✓\u001b[0m tests/suite-${idx + 1}.test.ts > passes check #${idx + 1} [1.20ms]`,
    ),
    "",
    " 60 pass",
    " 0 fail",
    "Ran 60 tests across 60 files. [98.00ms]",
  ].join("\n");

  const u1: Message = {
    id: "msg_001_user",
    sessionID: rootSession.id,
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 10, 0, 5) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  } as unknown as Message;

  const u1Parts: Part[] = [
    {
      id: "prt_u1",
      sessionID: rootSession.id,
      messageID: "msg_001_user",
      type: "text",
      text: "Проверь `src/auth/guard.ts`, обнови проверку префикса токена и прогони все тесты.",
    } as unknown as Part,
  ];

  const a1: Message = {
    id: "msg_002_assistant",
    sessionID: rootSession.id,
    role: "assistant",
    parentID: "msg_001_user",
    time: {
      created: Date.UTC(2026, 9, 30, 10, 1, 0),
      completed: Date.UTC(2026, 9, 30, 10, 20, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace/omnirush", root: "/workspace/omnirush" },
    cost: 0.0425,
    tokens: { input: 14_200, output: 1_850, reasoning: 640, cache: { read: 0, write: 0 } },
  } as unknown as Message;

  const a1Parts: Part[] = [
    {
      id: "prt_r1",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "reasoning",
      text: "First inspect legacy routes and auth/guard.ts, delegate audit to subagent, then apply the fix and re-run tests.",
      time: { start: 1, end: 2 },
    } as unknown as Part,
    {
      id: "prt_read_legacy_root",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_legacy_root",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/omnirush/src/routes/legacy.ts" },
        output: exploratoryReadV2,
        title: "src/routes/legacy.ts",
        metadata: {},
        time: { start: 2, end: 3 },
      },
    } as unknown as Part,
    {
      id: "prt_read_guard_before",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_guard_before",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/omnirush/src/auth/guard.ts" },
        output: authReadBefore,
        title: "src/auth/guard.ts",
        metadata: {},
        time: { start: 3, end: 4 },
      },
    } as unknown as Part,
    {
      id: "prt_read_guard_slice",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_guard_slice",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/omnirush/src/auth/guard.ts", offset: 10, limit: 16 },
        output: authSlice10to25,
        title: "src/auth/guard.ts (10-25)",
        metadata: {},
        time: { start: 4, end: 5 },
      },
    } as unknown as Part,
    {
      id: "prt_task_subagent",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_subagent_audit",
      tool: "task",
      state: {
        status: "completed",
        input: { description: "Audit routes & endpoints", subagent_type: "audit" },
        output: "Audit complete: all 24 v2 endpoints require omni_ prefix.",
        title: "Audit routes & endpoints",
        metadata: { sessionId: childSession.id },
        time: { start: 5, end: 10 },
      },
    } as unknown as Part,
    {
      id: "prt_bash_fail",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_bash_fail",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun test tests/guard-edge.test.ts" },
        output: failingTestOutput,
        title: "bun test tests/guard-edge.test.ts",
        metadata: { exit: 1 },
        time: { start: 11, end: 12 },
      },
    } as unknown as Part,
    {
      id: "prt_edit_guard",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_edit_guard",
      tool: "edit",
      state: {
        status: "completed",
        input: {
          filePath: "/workspace/omnirush/src/auth/guard.ts",
          oldString: "return token.length > 15;",
          newString: 'return token.startsWith("omni_") && token.length > 24;',
        },
        output: "Applied edit to src/auth/guard.ts",
        title: "Edit src/auth/guard.ts",
        metadata: {},
        time: { start: 13, end: 14 },
      },
    } as unknown as Part,
    {
      id: "prt_read_guard_after",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_guard_after",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/omnirush/src/auth/guard.ts" },
        output: authReadAfter,
        title: "src/auth/guard.ts",
        metadata: {},
        time: { start: 15, end: 16 },
      },
    } as unknown as Part,
    {
      id: "prt_bash_pass",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "tool",
      callID: "call_bash_pass",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun test" },
        output: passingTestOutput,
        title: "bun test",
        metadata: { exit: 0 },
        time: { start: 17, end: 18 },
      },
    } as unknown as Part,
    {
      id: "prt_final_answer",
      sessionID: rootSession.id,
      messageID: "msg_a1",
      type: "text",
      text: "Готово: проверка префикса `omni_` добавлена в `src/auth/guard.ts`, все 60 тестов проходят.",
    } as unknown as Part,
  ];

  // Reverted turn after `session.revert.messageID` — must be excluded in all modes!
  const revertedMsg: Message = {
    id: "msg_003_reverted",
    sessionID: rootSession.id,
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 10, 30, 0) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  } as unknown as Message;

  const revertedParts: Part[] = [
    {
      id: "prt_reverted",
      sessionID: rootSession.id,
      messageID: "msg_003_reverted",
      type: "text",
      text: "REVERTED_SECRET_SENTINEL_DO_NOT_EXPORT",
    } as unknown as Part,
  ];

  // Child subagent messages: re-reads legacy.ts (cross-session dedup!) + returns tabular JSON
  const childUser: Message = {
    id: "msg_cu1",
    sessionID: childSession.id,
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 10, 10, 5) },
    agent: "audit",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  } as unknown as Message;
  const childUserParts: Part[] = [
    {
      id: "prt_cu1",
      sessionID: childSession.id,
      messageID: "msg_cu1",
      type: "text",
      text: "Audit legacy routes and endpoint manifest.",
    } as unknown as Part,
  ];

  const childAssistant: Message = {
    id: "msg_ca1",
    sessionID: childSession.id,
    role: "assistant",
    parentID: "msg_cu1",
    time: {
      created: Date.UTC(2026, 9, 30, 10, 10, 10),
      completed: Date.UTC(2026, 9, 30, 10, 14, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "audit",
    agent: "audit",
    path: { cwd: "/workspace/omnirush", root: "/workspace/omnirush" },
    cost: 0.01,
    tokens: { input: 4_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as Message;
  const childAssistantParts: Part[] = [
    {
      id: "prt_child_read_dup",
      sessionID: childSession.id,
      messageID: "msg_ca1",
      type: "tool",
      callID: "call_child_legacy_dup",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/workspace/omnirush/src/routes/legacy.ts" },
        output: exploratoryReadV2,
        title: "src/routes/legacy.ts",
        metadata: {},
        time: { start: 6, end: 7 },
      },
    } as unknown as Part,
    {
      id: "prt_child_json_table",
      sessionID: childSession.id,
      messageID: "msg_ca1",
      type: "tool",
      callID: "call_child_endpoints_json",
      tool: "mcp_endpoints_list",
      state: {
        status: "completed",
        input: { version: "v2" },
        output: tabularJson,
        title: "List v2 endpoints",
        metadata: {},
        time: { start: 8, end: 9 },
      },
    } as unknown as Part,
    {
      id: "prt_child_summary",
      sessionID: childSession.id,
      messageID: "msg_ca1",
      type: "text",
      text: "Confirmed all 24 v2 endpoints require authentication.",
    } as unknown as Part,
  ];

  const todos: Todo[] = [
    { id: "todo_1", content: "Update token prefix guard", status: "completed", priority: "high" },
    { id: "todo_2", content: "Verify 60 unit tests pass", status: "completed", priority: "medium" },
  ];

  return {
    session: rootSession,
    messages: [
      { info: u1, parts: u1Parts },
      { info: a1, parts: a1Parts },
      { info: revertedMsg, parts: revertedParts },
    ],
    todos,
    subagentSessions: new Map([
      [
        childSession.id,
        {
          session: childSession,
          messages: [
            { info: childUser, parts: childUserParts },
            { info: childAssistant, parts: childAssistantParts },
          ],
          todos: [],
        },
      ],
    ]),
  };
}

describe("Session Markdown export end-to-end (Stage 4)", () => {
  test("maintains strict monotonicity across all 8 checkbox/mode combinations, 100% lossless round-trip, error preservation, and English-only service text", () => {
    const tree = makeRealisticMultiTurnSession();
    const ir = buildCanonicalTranscriptIR(tree);

    const modes: CompressionMode[] = ["off", "lossless", "smart", "stubs"];

    for (const includeReasoning of [true, false]) {
      const results = Object.fromEntries(
        modes.map((compression) => {
          const startedAt = performance.now();
          const res = renderTranscriptFromIR(ir, {
            includeToolCalls: true,
            includeReasoning,
            compression,
          });
          const elapsedMs = performance.now() - startedAt;
          // Live modal recalculation must remain fast (<50ms)
          expect(elapsedMs).toBeLessThan(50);
          return [compression, res];
        }),
      ) as Record<CompressionMode, ReturnType<typeof renderTranscriptFromIR>>;

      // Strict byte monotonicity even when includeReasoning is false!
      expect(results.stubs.utf8Bytes).toBeLessThan(results.smart.utf8Bytes);
      expect(results.smart.utf8Bytes).toBeLessThan(results.lossless.utf8Bytes);
      expect(results.lossless.utf8Bytes).toBeLessThan(results.off.utf8Bytes);

      for (const mode of modes) {
        const md = results[mode].markdown;

        // Reverted branch turn is never exported.
        expect(md).not.toContain("REVERTED_SECRET_SENTINEL_DO_NOT_EXPORT");

        // Cyrillic user & assistant messages are preserved verbatim.
        expect(md).toContain("Проверь `src/auth/guard.ts`");
        expect(md).toContain("Готово: проверка префикса `omni_` добавлена");

        // Failing test diagnostics and stack location are preserved in ALL modes.
        expect(md).toContain("rejects expired session");
        expect(md).toContain("at verifyGuard12 (/workspace/omnirush/src/auth/guard.ts:12:15)");

        // Latest snapshot of the edited file (`guard.ts`) is preserved in ALL modes (including Stubs!).
        expect(md).toContain('token.startsWith("omni_") && token.length > 24');

        // Reasoning toggle is respected cleanly.
        if (includeReasoning) {
          expect(md).toContain("> _Reasoning_");
        } else {
          expect(md).not.toContain("> _Reasoning_");
          expect(md).toContain("- **Omitted:** reasoning");
        }

        // Every generated service/structural line must be strictly English-only (zero Cyrillic).
        for (const line of md.split("\n")) {
          const isServiceLine =
            line.startsWith("- **") ||
            line.startsWith("## ") ||
            line.startsWith("### ") ||
            line.startsWith("**🛠 ") ||
            line.startsWith("> [") ||
            line.startsWith("<a id=") ||
            line.startsWith("_Source:") ||
            line.startsWith("[... ");
          if (isServiceLine) {
            expect(CYRILLIC_RE.test(line)).toBe(false);
          }
        }
      }

      // Lossless mode must pass 100% SHA-256 self-contained expansion & IR verification!
      const expanded = expandLosslessMarkdown(results.lossless.markdown);
      expect(expanded.some((b) => b.kind === "exact_ref")).toBe(true);
      expect(expanded.some((b) => b.kind === "range_ref")).toBe(true);
      expect(expanded.some((b) => b.kind === "delta_ref")).toBe(true);
      expect(expanded.some((b) => b.kind === "toon_table")).toBe(true);

      const verification = verifyLosslessRoundTrip(ir, results.lossless.markdown);
      expect(verification.verifiedBlocks.length).toBeGreaterThanOrEqual(4);
    }

    // Tool-calls disabled: produces compact prose-only transcript without 🛠 blocks.
    const proseOnly = renderTranscriptFromIR(ir, {
      includeToolCalls: false,
      includeReasoning: false,
      compression: "stubs",
    });
    expect(proseOnly.markdown).not.toContain("**🛠");
    expect(proseOnly.markdown).toContain("- **Omitted:** tool calls, reasoning");
    expect(proseOnly.utf8Bytes).toBeLessThan(ir.baselineBytes / 4);
  });
});
