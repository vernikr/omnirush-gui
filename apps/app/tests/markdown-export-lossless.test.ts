import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk/v2/client";

import {
  applyLosslessFileDelta,
  buildCanonicalTranscriptIR,
  computeLosslessFileDelta,
  decodeLosslessToon,
  DEFAULT_EXPORT_MARKDOWN_OPTIONS,
  expandLosslessMarkdown,
  formatSessionAsMarkdown,
  parseCanonicalReadEnvelope,
  renderTranscriptFromIR,
  sha256Hex,
  tryEncodeLosslessToon,
  tryFormatCompactJsonInput,
  utf8ByteLength,
  verifyLosslessRoundTrip,
  type ExportableSessionMessage,
  type ExportableSessionTree,
} from "../src/app/lib/session-markdown-export";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_lossless_01",
    slug: "lossless-export",
    projectID: "proj_1",
    directory: "/workspace/omnirush-gui",
    title: "Lossless Markdown Compression",
    version: "2.0.0",
    time: {
      created: Date.UTC(2026, 9, 30, 10, 0, 0),
      updated: Date.UTC(2026, 9, 30, 10, 30, 0),
    },
    ...overrides,
  };
}

function makeUser(id: string, sessionID: string, text: string): ExportableSessionMessage {
  const info: UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.UTC(2026, 9, 30, 10, 0, 0) },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  };
  return {
    info,
    parts: [{ id: `${id}_p1`, sessionID, messageID: id, type: "text", text }],
  };
}

function makeAssistant(
  id: string,
  sessionID: string,
  parentID: string,
  parts: Part[],
): ExportableSessionMessage {
  const info: AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: {
      created: Date.UTC(2026, 9, 30, 10, 1, 0),
      completed: Date.UTC(2026, 9, 30, 10, 2, 0),
    },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace/omnirush-gui", root: "/workspace/omnirush-gui" },
    cost: 0.025,
    tokens: {
      input: 2000,
      output: 600,
      reasoning: 400,
      cache: { read: 0, write: 0 },
    },
  };
  return { info, parts };
}

function makeV2ReadOutput(
  filePath: string,
  lines: string[],
  startLine = 1,
  footer?: string,
): string {
  const numbered = lines.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");
  const effectiveFooter = footer ?? `(End of file - total ${startLine + lines.length - 1} lines)`;
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${numbered}\n\n${effectiveFooter}\n</content>`;
}

function makeV1ReadOutput(lines: string[], startLine = 1, footer?: string): string {
  const numbered = lines
    .map((line, idx) => `${String(startLine + idx).padStart(5, "0")}| ${line}`)
    .join("\n");
  const effectiveFooter = footer ?? `(End of file - total ${startLine + lines.length - 1} lines)`;
  return `<file>\n${numbered}\n\n${effectiveFooter}\n</file>`;
}

describe("markdown-export Stage 1 lossless engine", () => {
  test("sha256Hex and utf8ByteLength match WebCrypto and TextEncoder across ASCII, Cyrillic, emoji, and lone surrogates", async () => {
    const encoder = new TextEncoder();
    const samples = [
      "",
      "abc",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "a".repeat(257),
      "Привет, мир! 🚀🧪漢字",
      "lone-high-\uD800-and-lone-low-\uDC00-and-pair-\uD83D\uDE80",
    ];

    for (const sample of samples) {
      const encoded = encoder.encode(sample);
      expect(utf8ByteLength(sample)).toBe(encoded.byteLength);

      const digestBuf = await crypto.subtle.digest("SHA-256", encoded);
      const expectedHex = Array.from(new Uint8Array(digestBuf), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      expect(sha256Hex(sample)).toBe(expectedHex);
    }
  });

  test("strictly canonicalizes OpenCode v1 and v2 Read file envelopes while rejecting directories and malformed lines", () => {
    const sampleLines = [
      'import { createServer } from "node:http";',
      "",
      "export function start(port: number) {",
      "  return createServer().listen(port);",
      "}",
      "",
    ];

    const v2 = parseCanonicalReadEnvelope({
      toolName: "read",
      rawOutput: makeV2ReadOutput("/workspace/omnirush-gui/src/server.ts", sampleLines, 1),
      input: { filePath: "/workspace/omnirush-gui/src/server.ts" },
      workspaceRoot: "/workspace/omnirush-gui",
    });
    expect(v2).not.toBeNull();
    expect(v2!.comparablePath).toBe("src/server.ts");
    expect(v2!.fenceLanguage).toBe("ts");
    expect(v2!.lines).toEqual(sampleLines);
    expect(v2!.firstLine).toBe(1);
    expect(v2!.lastLine).toBe(6);
    expect(v2!.footerKind).toBe("eof");

    const v1 = parseCanonicalReadEnvelope({
      toolName: "read",
      rawOutput: makeV1ReadOutput(sampleLines, 1),
      input: { filePath: "./src/server.ts" },
      workspaceRoot: "/workspace/omnirush-gui",
    });
    expect(v1).not.toBeNull();
    expect(v1!.comparablePath).toBe("src/server.ts");
    expect(v1!.cleanBodySha256).toBe(v2!.cleanBodySha256);

    // Engine2 `Read file <path>, lines <start>-<end>` + `[Output truncated. Continue reading with offset: N]`
    const engine2Numbered = sampleLines.map((line, idx) => `${idx + 1}: ${line}`).join("\n");
    const engine2Truncated = parseCanonicalReadEnvelope({
      toolName: "read",
      rawOutput: `Read file /workspace/omnirush-gui/src/server.ts, lines 1-${sampleLines.length}\n${engine2Numbered}\n[Output truncated. Continue reading with offset: ${sampleLines.length + 1}]`,
      input: { filePath: "/workspace/omnirush-gui/src/server.ts" },
      workspaceRoot: "/workspace/omnirush-gui",
    });
    expect(engine2Truncated).not.toBeNull();
    expect(engine2Truncated!.comparablePath).toBe("src/server.ts");
    expect(engine2Truncated!.cleanBodySha256).toBe(v2!.cleanBodySha256);
    expect(engine2Truncated!.truncated).toBe(true);
    expect(engine2Truncated!.footerKind).toBe("more_lines");

    // Directory listings must NOT be misclassified as file bodies
    const dirEnvelope = `<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nserver.ts\n(1 entries)\n</entries>`;
    expect(
      parseCanonicalReadEnvelope({
        toolName: "read",
        rawOutput: dirEnvelope,
        input: { filePath: "/workspace/src" },
      }),
    ).toBeNull();

    // Non-contiguous line numbers must bail out safely
    const broken = `<file>\n00001| first\n00003| jumped\n</file>`;
    expect(
      parseCanonicalReadEnvelope({
        toolName: "read",
        rawOutput: broken,
        input: { filePath: "broken.txt" },
      }),
    ).toBeNull();
  });

  test("round-trips lossless file deltas even with embedded @@ directives, backticks, and trailing blank lines", () => {
    const baseLines = Array.from({ length: 80 }, (_, idx) => `const line_${idx + 1} = ${idx + 1};`);
    baseLines.push("");

    const targetLines = [...baseLines];
    targetLines.splice(
      35,
      2,
      'const updated = "new value";',
      "@@ keep base 1..999 (999 unchanged lines) @@",
      "const markdownFence = '```diff';",
    );

    const targetSha = sha256Hex(targetLines.join("\n"));
    const delta = computeLosslessFileDelta(baseLines, targetLines, targetSha);
    expect(delta).not.toBeNull();
    expect(delta!).toContain("@@ keep base ");
    expect(delta!).toContain("+@@ keep base 1..999 (999 unchanged lines) @@");

    const reconstructed = applyLosslessFileDelta(baseLines, delta!);
    expect(reconstructed).toEqual(targetLines);
    expect(sha256Hex(reconstructed.join("\n"))).toBe(targetSha);
  });

  test("encodes and decodes TOON-JSON v1 losslessly while preserving primitive types and skipping irregular JSON", () => {
    const wrapperPayload = {
      status: "ok",
      total: 6,
      diagnostics: [
        { id: "1", line: 12, fatal: false, code: "TS2322", message: 'Type "123" is not assignable, see docs', hint: null },
        { id: "2", line: 45, fatal: true, code: "TS2304", message: "Cannot find name 'window'", hint: "dom" },
        { id: "3", line: 88, fatal: false, code: "TS6133", message: "'unused' is declared but never read", hint: null },
        { id: "4", line: 102, fatal: false, code: "TS7006", message: "Parameter 'x' implicitly has an 'any' type", hint: null },
        { id: "5", line: 149, fatal: true, code: "TS2554", message: "Expected 2 arguments, but got 1", hint: "check sig" },
        { id: "6", line: 210, fatal: false, code: "TS18048", message: "'item' is possibly 'undefined'", hint: null },
      ],
    };

    const pretty = JSON.stringify(wrapperPayload, null, 2);
    const toon = tryEncodeLosslessToon(wrapperPayload, pretty);
    expect(toon).not.toBeNull();
    expect(decodeLosslessToon(toon!)).toEqual(wrapperPayload);

    // Irregular keys or nested objects must return null so standard JSON is preserved
    const irregular = [
      { id: 1, nested: { a: 1 } },
      { id: 2, nested: { a: 2 } },
      { id: 3, nested: { a: 3 } },
      { id: 4, nested: { a: 4 } },
    ];
    expect(tryEncodeLosslessToon(irregular, JSON.stringify(irregular, null, 2))).toBeNull();

    expect(tryFormatCompactJsonInput({ filePath: "src/auth.ts", offset: 1, limit: 100 })).toBe(
      '{"filePath": "src/auth.ts", "offset": 1, "limit": 100}',
    );
    expect(tryFormatCompactJsonInput({ content: "line1\nline2" })).toBeNull();
  });

  test("compresses multi-turn + subagent transcript losslessly, verifies 100% SHA-256 round-trip, respects Undo, and emits English-only service text", () => {
    const sourceFileLines = Array.from(
      { length: 90 },
      (_, idx) => `export const configValue_${String(idx + 1).padStart(3, "0")} = "setting_${idx + 1}_with_realistic_padding";`,
    );
    // Include triple backticks and trailing blank line inside the source file
    sourceFileLines[10] = 'export const docComment = "Example:\\n```ts\\nconst x = 1;\\n```";';
    sourceFileLines.push("");

    const editedFileLines = [...sourceFileLines];
    editedFileLines[44] = 'export const configValue_045 = "UPDATED_AFTER_EDIT_045";';
    editedFileLines.splice(45, 0, 'export const injectedFlag = true;');

    const repeatedBashOutput = Array.from(
      { length: 28 },
      (_, i) => `packages/module-${i + 1}/src/index.ts: clean (0 warnings, 0 errors)`,
    ).join("\n");

    const uniformMcpJson = JSON.stringify(
      Array.from({ length: 8 }, (_, idx) => ({
        issueNumber: 300 + idx,
        state: idx % 2 === 0 ? "open" : "closed",
        author: `dev_${idx}`,
        title: `Deterministic export check #${idx + 1}`,
        milestone: null,
      })),
      null,
      2,
    );

    const subagentId = "ses_child_lossless";
    const childTree: ExportableSessionTree = {
      session: makeSession({
        id: subagentId,
        parentID: "ses_lossless_01",
        title: "Verify config module",
      }),
      messages: [
        makeUser("msg_c1", subagentId, "Check src/config.ts inside subagent."),
        makeAssistant("msg_c2", subagentId, "msg_c1", [
          {
            id: "prt_c_reason",
            sessionID: subagentId,
            messageID: "msg_c2",
            type: "reasoning",
            text: "Re-reading the full config file in the subagent.",
            time: { start: 1, end: 2 },
          },
          // Exact cross-session re-read (v1 envelope matching parent's v2 envelope!)
          {
            id: "prt_c_read",
            sessionID: subagentId,
            messageID: "msg_c2",
            type: "tool",
            callID: "call_c_read",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/config.ts" },
              output: makeV1ReadOutput(sourceFileLines, 1),
              title: "src/config.ts",
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
        ]),
      ],
    };

    const rootTree: ExportableSessionTree = {
      session: makeSession({
        revert: { messageID: "msg_05" },
      }),
      subagentSessions: new Map([[subagentId, childTree]]),
      messages: [
        makeUser(
          "msg_01",
          "ses_lossless_01",
          "Inspect src/config.ts, run checks, and note this literal example:\n```markdown\n<a id=\"export-ref-c999\"></a>\n> [↩ Identical to Turn 99 · Bash · `sha256:000000000000`](#export-ref-c999)\n```",
        ),
        makeAssistant("msg_02", "ses_lossless_01", "msg_01", [
          {
            id: "prt_r1",
            sessionID: "ses_lossless_01",
            messageID: "msg_02",
            type: "reasoning",
            text: "First I will read src/config.ts and run the workspace check.",
            time: { start: 10, end: 12 },
          },
          // 1. Initial full Read (v2 envelope)
          {
            id: "prt_t1",
            sessionID: "ses_lossless_01",
            messageID: "msg_02",
            type: "tool",
            callID: "call_1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/workspace/omnirush-gui/src/config.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/config.ts", sourceFileLines, 1),
              title: "src/config.ts",
              metadata: {},
              time: { start: 12, end: 15 },
            },
          },
          // 2. Bash output #1
          {
            id: "prt_t2",
            sessionID: "ses_lossless_01",
            messageID: "msg_02",
            type: "tool",
            callID: "call_2",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pnpm check:modules" },
              output: repeatedBashOutput,
              title: "Check modules",
              metadata: {},
              time: { start: 15, end: 18 },
            },
          },
          // 3. Spawn subagent (which re-reads src/config.ts)
          {
            id: "prt_t3",
            sessionID: "ses_lossless_01",
            messageID: "msg_02",
            type: "tool",
            callID: "call_3",
            tool: "task",
            state: {
              status: "completed",
              input: { description: "Verify config module", subagent_type: "explore" },
              output: "Subagent verified src/config.ts",
              title: "Verify config module",
              metadata: { sessionId: subagentId },
              time: { start: 18, end: 25 },
            },
          },
        ]),
        makeUser("msg_03", "ses_lossless_01", "Now read lines 20-55, update line 45, and re-verify."),
        makeAssistant("msg_04", "ses_lossless_01", "msg_03", [
          // 4. Line-range containment Read (L20-L55 inside Turn 2's L1-L91)
          {
            id: "prt_t4",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "tool",
            callID: "call_4",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/config.ts", offset: 20, limit: 36 },
              output: makeV2ReadOutput(
                "/workspace/omnirush-gui/src/config.ts",
                sourceFileLines.slice(19, 55),
                20,
                "(Showing lines 20-55 of 91. Use offset=56 to continue.)",
              ),
              title: "src/config.ts",
              metadata: {},
              time: { start: 30, end: 31 },
            },
          },
          // 5. Post-edit full Read (1-hop delta against Turn 2's Read)
          {
            id: "prt_t5",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "tool",
            callID: "call_5",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/config.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/config.ts", editedFileLines, 1),
              title: "src/config.ts",
              metadata: {},
              time: { start: 32, end: 34 },
            },
          },
          // 6. Identical re-read of the edited file (exact dedup chaining onto the delta block!)
          {
            id: "prt_t6",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "tool",
            callID: "call_6",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/config.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/config.ts", editedFileLines, 1),
              title: "src/config.ts",
              metadata: {},
              time: { start: 35, end: 36 },
            },
          },
          // 7. Identical Bash output #2
          {
            id: "prt_t7",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "tool",
            callID: "call_7",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pnpm check:modules" },
              output: repeatedBashOutput,
              title: "Check modules again",
              metadata: {},
              time: { start: 36, end: 38 },
            },
          },
          // 8. Uniform JSON array output -> TOON table
          {
            id: "prt_t8",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "tool",
            callID: "call_8",
            tool: "github_list_issues",
            state: {
              status: "completed",
              input: { repo: "omnirush-ai/omnirush-gui", limit: 8 },
              output: uniformMcpJson,
              title: "List issues",
              metadata: {},
              time: { start: 38, end: 40 },
            },
          },
          {
            id: "prt_final_text",
            sessionID: "ses_lossless_01",
            messageID: "msg_04",
            type: "text",
            text: "Configuration updated and verified.",
          },
        ]),
        // Reverted turn (must be completely excluded from IR and anchors)
        makeUser("msg_05", "ses_lossless_01", "REVERTED_TURN_MUST_NOT_APPEAR"),
      ],
    };

    const ir = buildCanonicalTranscriptIR(rootTree);
    const losslessResult = renderTranscriptFromIR(ir, DEFAULT_EXPORT_MARKDOWN_OPTIONS);

    // 1. Byte metrics and substantial net compression win
    expect(losslessResult.utf8Bytes).toBe(new TextEncoder().encode(losslessResult.markdown).byteLength);
    expect(losslessResult.baselineBytes).toBe(
      new TextEncoder().encode(formatSessionAsMarkdown(rootTree)).byteLength,
    );
    expect(losslessResult.utf8Bytes).toBeLessThan(losslessResult.baselineBytes * 0.6);
    expect(losslessResult.savedBytes).toBe(losslessResult.baselineBytes - losslessResult.utf8Bytes);

    // 2. Verify all Stage 1 passes triggered
    expect(losslessResult.stats.exactDedupCount).toBe(3); // subagent Read + edited Read re-read + repeated Bash
    expect(losslessResult.stats.rangeRefCount).toBe(1);
    expect(losslessResult.stats.deltaCount).toBe(1);
    expect(losslessResult.stats.canonicalReadCount).toBe(1);
    expect(losslessResult.stats.toonTableCount).toBe(1);
    expect(losslessResult.stats.compactJsonCount).toBeGreaterThanOrEqual(6);

    // 3. Reverted turn is absent, fake anchor inside user code block was NOT parsed as real anchor
    expect(losslessResult.markdown).not.toContain("REVERTED_TURN_MUST_NOT_APPEAR");
    const roundTrip = verifyLosslessRoundTrip(ir, losslessResult.markdown);
    expect(roundTrip.verifiedBlocks.some((b) => b.anchorId === "export-ref-c999")).toBe(false);

    // Verify exact reconstructed payloads match original source data byte-for-byte
    const deltaExpanded = roundTrip.verifiedBlocks.find((b) => b.kind === "delta_ref");
    expect(deltaExpanded).toBeDefined();
    expect(deltaExpanded!.reconstructedText).toBe(editedFileLines.join("\n"));

    const rangeExpanded = roundTrip.verifiedBlocks.find((b) => b.kind === "range_ref");
    expect(rangeExpanded).toBeDefined();
    expect(rangeExpanded!.reconstructedText).toBe(sourceFileLines.slice(19, 55).join("\n"));

    const toonExpanded = roundTrip.verifiedBlocks.find((b) => b.kind === "toon_table");
    expect(toonExpanded).toBeDefined();
    expect(JSON.parse(toonExpanded!.reconstructedText)).toEqual(JSON.parse(uniformMcpJson));

    // 4. Zero Russian / Cyrillic characters anywhere in exported output when session content is ASCII
    expect(/[\u0400-\u04FF]/.test(losslessResult.markdown)).toBe(false);

    // 5. Filtering checkboxes (includeToolCalls / includeReasoning) recalculate live size cleanly
    const noTools = renderTranscriptFromIR(ir, {
      includeToolCalls: false,
      includeReasoning: true,
      compression: "lossless",
    });
    expect(noTools.markdown).toContain("- **Omitted:** tool calls");
    expect(noTools.markdown).not.toContain("**🛠");
    expect(noTools.markdown).toContain("> _Reasoning_");
    expect(noTools.utf8Bytes).toBeLessThan(losslessResult.utf8Bytes);

    const dialogueOnly = renderTranscriptFromIR(ir, {
      includeToolCalls: false,
      includeReasoning: false,
      compression: "lossless",
    });
    expect(dialogueOnly.markdown).toContain("- **Omitted:** tool calls, reasoning");
    expect(dialogueOnly.markdown).not.toContain("> _Reasoning_");
    expect(dialogueOnly.utf8Bytes).toBeLessThan(noTools.utf8Bytes);
  });

  test("emits zero HTML anchors when a session has no duplicate, range, or delta references", () => {
    const tree: ExportableSessionTree = {
      session: makeSession(),
      messages: [
        makeUser("m1", "ses_lossless_01", "Read a short file."),
        makeAssistant("m2", "ses_lossless_01", "m1", [
          {
            id: "p1",
            sessionID: "ses_lossless_01",
            messageID: "m2",
            type: "tool",
            callID: "c1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/tiny.ts" },
              output: makeV2ReadOutput("/workspace/omnirush-gui/src/tiny.ts", ["export const x = 1;"], 1),
              title: "src/tiny.ts",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ]),
      ],
    };

    const ir = buildCanonicalTranscriptIR(tree);
    const rendered = renderTranscriptFromIR(ir, DEFAULT_EXPORT_MARKDOWN_OPTIONS);
    expect(rendered.markdown).not.toContain("<a id=");
    expect(rendered.stats.anchorCount).toBe(0);
    expect(expandLosslessMarkdown(rendered.markdown)).toEqual([]);
    expect(rendered.utf8Bytes).toBeLessThanOrEqual(rendered.baselineBytes);
  });
});
