import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk/v2/client";

import {
  buildSessionExportFilename,
  collectReferencedSubagentSessionIds,
  fenceMarkdownCode,
  filterVisibleBranchMessages,
  formatSessionAsMarkdown,
  parseExportSlashCommand,
  validateRelativeExportPath,
  type ExportableSessionMessage,
  type ExportableSessionTree,
} from "../src/app/lib/session-markdown-export";
import { exportSessionMarkdown } from "../src/react-app/domains/session/commands/export-session-markdown";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_root123456",
    slug: "fix-export",
    projectID: "proj_1",
    directory: "/workspace/omnirush-gui",
    title: "Implement Markdown branch export",
    version: "2.0.0",
    time: {
      created: Date.UTC(2026, 9, 29, 10, 0, 0),
      updated: Date.UTC(2026, 9, 29, 10, 15, 0),
    },
    ...overrides,
  };
}

function makeUserMessage(id: string, sessionID: string, parts: Part[]): ExportableSessionMessage {
  const info: UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.UTC(2026, 9, 29, 10, 0, 0) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  };
  return { info, parts };
}

function makeAssistantMessage(
  id: string,
  sessionID: string,
  parentID: string,
  parts: Part[],
  overrides: Partial<AssistantMessage> = {},
): ExportableSessionMessage {
  const info: AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: {
      created: Date.UTC(2026, 9, 29, 10, 1, 0),
      completed: Date.UTC(2026, 9, 29, 10, 2, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace/omnirush-gui", root: "/workspace/omnirush-gui" },
    cost: 0.0425,
    tokens: {
      input: 1200,
      output: 450,
      reasoning: 300,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
  return { info, parts };
}

describe("session-markdown-export", () => {
  test("formats full session with reasoning, tool calls, nested subagent, attachments, errors, and todos", () => {
    const childSessionId = "ses_subagent_01";
    const childTree: ExportableSessionTree = {
      session: makeSession({
        id: childSessionId,
        parentID: "ses_root123456",
        title: "Audit FreeBuff export",
      }),
      messages: [
        makeUserMessage("msg_sub_01", childSessionId, [
          {
            id: "prt_sub_1",
            sessionID: childSessionId,
            messageID: "msg_sub_01",
            type: "text",
            text: "Inspect FreeBuff /export implementation.",
          },
        ]),
        makeAssistantMessage("msg_sub_02", childSessionId, "msg_sub_01", [
          {
            id: "prt_sub_2",
            sessionID: childSessionId,
            messageID: "msg_sub_02",
            type: "reasoning",
            text: "Checking copy-conversation.ts and export-conversation.ts.",
            time: { start: 1, end: 2 },
          },
          {
            id: "prt_sub_3",
            sessionID: childSessionId,
            messageID: "msg_sub_02",
            type: "tool",
            callID: "call_sub_read",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "cli/src/commands/export-conversation.ts" },
              output: "{\"ok\":true,\"lines\":95}",
              title: "cli/src/commands/export-conversation.ts",
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
          {
            id: "prt_sub_4",
            sessionID: childSessionId,
            messageID: "msg_sub_02",
            type: "text",
            text: "FreeBuff writes a full Markdown transcript with reasoning blockquotes and tool blocks.",
          },
        ]),
      ],
    };

    const rootTree: ExportableSessionTree = {
      session: makeSession({ parentID: "ses_branch_origin" }),
      subagentSessions: new Map([[childSessionId, childTree]]),
      todos: [
        { content: "Serialize reasoning and tool calls", status: "completed", priority: "high" },
        { content: "Wire /export slash command", status: "in_progress", priority: "medium" },
      ],
      messages: [
        makeUserMessage("msg_01", "ses_root123456", [
          {
            id: "prt_1",
            sessionID: "ses_root123456",
            messageID: "msg_01",
            type: "file",
            mime: "text/markdown",
            filename: "SPEC.md",
            url: "file:///workspace/omnirush-gui/SPEC.md",
          },
          {
            id: "prt_1_hidden",
            sessionID: "ses_root123456",
            messageID: "msg_01",
            type: "text",
            synthetic: true,
            text: "<system-reminder>internal context</system-reminder>",
          },
          {
            id: "prt_2",
            sessionID: "ses_root123456",
            messageID: "msg_01",
            type: "text",
            text: "Экспортируй полное содержимое ветки в md файл.",
          },
        ]),
        makeAssistantMessage("msg_02", "ses_root123456", "msg_01", [
          {
            id: "prt_3",
            sessionID: "ses_root123456",
            messageID: "msg_02",
            type: "reasoning",
            text: "First line of thinking.\n\nSecond paragraph after blank line.",
            time: { start: 10, end: 20 },
          },
          {
            id: "prt_4",
            sessionID: "ses_root123456",
            messageID: "msg_02",
            type: "tool",
            callID: "call_task_1",
            tool: "task",
            state: {
              status: "completed",
              input: {
                description: "Audit FreeBuff export",
                subagent_type: "explore",
                prompt: "Check how FreeBuff formats reasoning and tool calls",
              },
              output: "Audit complete.",
              title: "Audit FreeBuff export",
              metadata: { sessionId: childSessionId },
              time: { start: 20, end: 30 },
            },
          },
          {
            id: "prt_5",
            sessionID: "ses_root123456",
            messageID: "msg_02",
            type: "tool",
            callID: "call_bash_err",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "pnpm check" },
              error: "Process exited with code 1",
              metadata: { output: "src/foo.ts(1,1): error TS1005" },
              time: { start: 31, end: 35 },
            },
          },
          {
            id: "prt_6",
            sessionID: "ses_root123456",
            messageID: "msg_02",
            type: "text",
            text: "Готово — ветка экспортирована со всеми рассуждениями и инструментами.",
          },
        ]),
      ],
    };

    const md = formatSessionAsMarkdown(rootTree);

    expect(md).toContain("# Implement Markdown branch export");
    expect(md).toContain("_2 messages · Session `ses_root123456`_");
    expect(md).toContain("- **Workspace:** `/workspace/omnirush-gui`");
    expect(md).toContain("- **Parent session:** `ses_branch_origin`");
    expect(md).toContain("- **Models:** `anthropic/claude-sonnet-4-5`");
    expect(md).toContain("- **Tokens:** 1,200 input, 450 output, 300 reasoning ($0.0425)");
    expect(md).toContain("> Attached files: SPEC.md (text/markdown)");
    expect(md).not.toContain("internal context");
    expect(md).toContain("Экспортируй полное содержимое ветки в md файл.");
    expect(md).toContain("> _Reasoning_\n> First line of thinking.\n>\n> Second paragraph after blank line.");
    expect(md).toContain("**🛠 Task** — Audit FreeBuff export");
    expect(md).toContain("### ⤷ Subagent: Audit FreeBuff export (explore)");
    expect(md).toContain("> _Reasoning_\n> Checking copy-conversation.ts and export-conversation.ts.");
    expect(md).toContain("**🛠 Read** — cli/src/commands/export-conversation.ts");
    expect(md).toContain("```json\n{\n  \"ok\": true,\n  \"lines\": 95\n}\n```");
    expect(md).toContain("### ⤶ End subagent");
    expect(md).toContain("**🛠 Bash** _(error)_");
    expect(md).toContain("src/foo.ts(1,1): error TS1005");
    expect(md).toContain("_Error:_\n```\nProcess exited with code 1\n```");
    expect(md).toContain("## Tasks\n\n- [x] Serialize reasoning and tool calls\n- [ ] Wire /export slash command _(in progress)_");
  });

  test("upgrades dynamic backtick fences when tool output itself contains triple or quadruple backticks", () => {
    const nestedMd = "# Example\n```ts\nconst x = 1;\n```\n````md\nnested\n````";
    const fenced = fenceMarkdownCode(nestedMd, "markdown");
    expect(fenced.startsWith("`````markdown\n")).toBe(true);
    expect(fenced.endsWith("\n`````")).toBe(true);
  });

  test("respects branch revert boundary (Undo) and prevents subagent cycles", () => {
    const session = makeSession({
      id: "ses_cycle",
      revert: { messageID: "msg_03" },
    });
    const messages: ExportableSessionMessage[] = [
      makeUserMessage("msg_01", "ses_cycle", [
        { id: "p1", sessionID: "ses_cycle", messageID: "msg_01", type: "text", text: "Kept prompt" },
      ]),
      makeAssistantMessage("msg_02", "ses_cycle", "msg_01", [
        {
          id: "p2",
          sessionID: "ses_cycle",
          messageID: "msg_02",
          type: "tool",
          callID: "c1",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Self reference" },
            output: "done",
            title: "Self reference",
            metadata: { sessionId: "ses_cycle" },
            time: { start: 1, end: 2 },
          },
        },
      ]),
      makeUserMessage("msg_03", "ses_cycle", [
        { id: "p3", sessionID: "ses_cycle", messageID: "msg_03", type: "text", text: "Undone prompt" },
      ]),
    ];

    expect(filterVisibleBranchMessages(session, messages).map((m) => m.info.id)).toEqual(["msg_01", "msg_02"]);
    expect(collectReferencedSubagentSessionIds(session, messages)).toEqual(["ses_cycle"]);

    const tree: ExportableSessionTree = { session, messages };
    tree.subagentSessions = new Map([["ses_cycle", tree]]);
    const md = formatSessionAsMarkdown(tree);
    expect(md).toContain("Kept prompt");
    expect(md).not.toContain("Undone prompt");
    expect(md).not.toContain("⤷ Subagent");
  });

  test("sanitizes and bounds export filenames across Unicode and long titles", () => {
    expect(buildSessionExportFilename({ id: "ses_abcdef123456", title: "" })).toBe(
      "omnirush-chat-ses_abcdef123456.md",
    );

    const cyrillicName = buildSessionExportFilename({
      id: "ses_9876543210",
      title: "Экспорт ветки: рассуждения / вызовы инструментов?",
    });
    expect(cyrillicName.endsWith("-9876543210.md")).toBe(true);
    expect(cyrillicName).toContain("Экспорт-ветки");
    expect(cyrillicName).not.toMatch(/[/:?]/);

    const hugeTitle = "Очень длинное название сессии ".repeat(20);
    const bounded = buildSessionExportFilename({ id: "ses_1122334455", title: hugeTitle });
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThan(100);
    expect(bounded.endsWith("-1122334455.md")).toBe(true);
  });

  test("parses /export slash commands and validates workspace relative paths", () => {
    expect(parseExportSlashCommand("/export")).toEqual({ filename: null });
    expect(parseExportSlashCommand("  /EXPORT   ")).toEqual({ filename: null });
    expect(parseExportSlashCommand("/export branch-notes")).toEqual({ filename: "branch-notes.md" });
    expect(parseExportSlashCommand('/export "docs/my transcript.md"')).toEqual({
      filename: "docs/my transcript.md",
    });
    expect(parseExportSlashCommand("/exporting something")).toBeNull();
    expect(parseExportSlashCommand("please /export this")).toBeNull();

    expect(validateRelativeExportPath("notes/session.md")).toEqual({
      ok: true,
      relativePath: "notes/session.md",
    });
    expect(validateRelativeExportPath("../outside.md").ok).toBe(false);
    expect(validateRelativeExportPath("a/../../outside.md").ok).toBe(false);
    expect(validateRelativeExportPath("/etc/passwd.md").ok).toBe(false);
    expect(validateRelativeExportPath("C:\\temp\\out.md").ok).toBe(false);
    expect(validateRelativeExportPath("notes/").ok).toBe(false);
  });

  test("fetches ALL cursor-paginated V2 messages (>200 turns) and child subagent transcripts without truncation", async () => {
    const totalTurns = 245;
    const allNewestFirst = Array.from({ length: totalTurns }, (_, idx) => {
      const turnNumber = totalTurns - idx;
      const padded = String(turnNumber).padStart(4, "0");
      const msgId = `msg_${padded}`;
      if (turnNumber % 2 === 1) {
        return {
          id: msgId,
          sessionID: "ses_paged",
          role: "user",
          time: { created: turnNumber * 1000 },
          content: [{ type: "text", text: `User message #${turnNumber}` }],
        };
      }
      const content: Array<Record<string, unknown>> = [
        {
          type: "reasoning",
          text: `Reasoning for turn #${turnNumber}`,
          time: { created: turnNumber * 1000, completed: turnNumber * 1000 + 500 },
        },
        {
          type: "text",
          text: `Assistant reply #${turnNumber}`,
        },
      ];
      if (turnNumber === 2) {
        content.splice(1, 0, {
          type: "tool",
          id: "call_sub_1",
          name: "task",
          state: {
            status: "completed",
            input: { description: "Deep check", subagent_type: "general" },
            result: "Subagent finished",
            title: "Deep check",
            metadata: { sessionId: "ses_child_paged" },
          },
        });
      }
      return {
        id: msgId,
        sessionID: "ses_paged",
        role: "assistant",
        time: { created: turnNumber * 1000, completed: turnNumber * 1000 + 900 },
        content,
      };
    });

    let writtenFile: { path: string; content: string } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/api/session/ses_paged")) {
          return Response.json({
            id: "ses_paged",
            directory: "/workspace/omnirush-gui",
            title: "Long Paginated Thread",
            time: { created: 1000, updated: 250000 },
          });
        }
        if (url.pathname.endsWith("/api/session/ses_child_paged")) {
          return Response.json({
            id: "ses_child_paged",
            parentID: "ses_paged",
            directory: "/workspace/omnirush-gui",
            title: "Child",
            time: { created: 2000, updated: 3000 },
          });
        }
        if (url.pathname.endsWith("/api/session/ses_child_paged/message")) {
          return Response.json({
            data: [
              {
                id: "msg_c1",
                sessionID: "ses_child_paged",
                role: "user",
                time: { created: 2100 },
                content: [{ type: "text", text: "Subagent prompt" }],
              },
            ],
          });
        }
        if (url.pathname.endsWith("/api/session/ses_paged/message")) {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const cursor = url.searchParams.get("cursor");
          const startIdx = cursor ? Number(cursor) : 0;
          const slice = allNewestFirst.slice(startIdx, startIdx + limit);
          const nextIdx = startIdx + slice.length;
          return Response.json({
            data: slice,
            ...(nextIdx < allNewestFirst.length ? { cursor: { next: String(nextIdx) } } : {}),
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const mockServerClient = {
        statWorkspaceFile: async () => ({ ok: true, path: "exports/full.md", exists: false }),
        writeWorkspaceFile: async (_wsId: string, payload: { path: string; content: string }) => {
          writtenFile = payload;
          return { ok: true, path: payload.path, size: payload.content.length, updatedAt: Date.now() };
        },
      };

      const outcome = await exportSessionMarkdown({
        workspaceId: "ws_1",
        sessionId: "ses_paged",
        opencodeBaseUrl: `http://127.0.0.1:${server.port}/opencode2`,
        token: "test-token",
        // @ts-expect-error minimal server client stub for unit test
        serverClient: mockServerClient,
        relativeFilename: "exports/full",
      });

      expect(outcome).toEqual({ outcome: "saved", path: "exports/full.md" });
      expect(writtenFile).not.toBeNull();
      expect(writtenFile!.content).toContain("_245 messages · Session `ses_paged`_");
      expect(writtenFile!.content).toContain("User message #1");
      expect(writtenFile!.content).toContain("Reasoning for turn #2");
      expect(writtenFile!.content).toContain("### ⤷ Subagent: Deep check (general)");
      expect(writtenFile!.content).toContain("Subagent prompt");
      expect(writtenFile!.content).toContain("User message #245");
    } finally {
      server.stop(true);
    }
  });
});
