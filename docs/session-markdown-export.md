# Session Markdown export

Export the full contents of any chat session/branch — including model reasoning traces, tool call inputs and outputs, errors, file attachments, task checklists, and nested sub-agent sessions — to a standalone `.md` file.

## How to export

- **Session header:** click the **Export as Markdown** (`Download`) button in the top-right session controls, or choose **Export as Markdown** from the `…` (**More actions**) menu on narrow windows and in IDE layout.
- **Sidebar:** right-click any session row (or click its `…` menu) and choose **Export as Markdown**.
- **Command Palette (`Cmd+K` / `Ctrl+K`):** run **Export chat as Markdown** while a session pane is focused (including split-view side chats).
- **Composer slash command:**
  - `/export` — opens the native Save dialog on desktop (or downloads `<title>-<id>.md` on web).
  - `/export <filename>` (for example `/export notes/auth-debug.md` or `/export session-trace`) — writes directly inside the current project folder without sending a prompt to the model. Relative path escapes (`..`, symlinks outside the workspace, absolute paths) and overwriting existing files are refused.

On desktop, the completion toast includes a **Show file** action that reveals the exported `.md` file in Finder / Explorer / your file manager.

## What is included

1. **Metadata header:** session title, message count, session ID, workspace path, parent session ID (when branched or spawned), created/updated UTC timestamps, models used, and token/cost totals when reported by the engine.
2. **Complete unwindowed branch history:** fetches all cursor-paginated pages from the OpenCode engine (`limit = Infinity`) in chronological order while respecting active Undo (`session.revert`) branch boundaries.
3. **Model reasoning:** rendered as `> _Reasoning_` Markdown blockquotes in exact step order.
4. **Tool calls (`🛠 <Tool>`):** pretty-printed JSON inputs, JSON or raw text outputs, partial live output and error blocks for failed commands, and tool attachments. Code fences automatically widen to 4+ backticks whenever tool input/output itself contains triple-backtick blocks so nested Markdown never breaks the document structure.
5. **Sub-agent transcripts:** `task` tool calls that spawned child sessions (`state.metadata.sessionId`) recursively inline the child session's turns, reasoning, and tool calls inside `### ⤷ Subagent: …` / `### ⤶ End subagent` sections (with cycle protection).
6. **Tasks checklist:** active session todos (`[x]` / `[ ]`) when present.

## Upstream tracking

- OmniRush GUI feature request: [omnirush-ai/omnirush-gui#349](https://github.com/omnirush-ai/omnirush-gui/issues/349)
- Related OpenCode Desktop & CLI issues: [anomalyco/opencode#55542](https://github.com/anomalyco/opencode/issues/55542), [anomalyco/opencode#59904](https://github.com/anomalyco/opencode/issues/59904)
