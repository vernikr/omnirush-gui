# Session Markdown export

Export the full contents of any chat session/branch — including model reasoning traces, tool call inputs and outputs, errors, file attachments, task checklists, and nested sub-agent sessions — to a standalone `.md` file with deterministic, LLM-free transcript compression.

## How to export

All interactive UI entry points open the **Export session as Markdown** modal:

- **Session header:** click the **Export as Markdown** (`Download`) button in the top-right session controls, or choose **Export as Markdown** from the `…` (**More actions**) menu on narrow windows and in IDE layout.
- **Sidebar:** right-click any session row (or click its `…` menu) and choose **Export as Markdown**.
- **Command Palette (`Cmd+K` / `Ctrl+K`):** run **Export session as Markdown** while a session pane is focused (including split-view side chats).
- **Composer slash command:**
  - `/export` — opens the export modal and saves `<title>-<id>.md` directly into your `Downloads` folder (with automatic `(1)`, `(2)` collision numbering so existing files are never overwritten).
  - `/export <filename>` (for example `/export session-trace` or `/export auth-debug.md`) — opens the export modal targeting `<filename>.md` in `Downloads` (or an explicit relative project subfolder like `/export notes/auth-debug.md` while refusing path traversal and overwrites).

On desktop, exported files save directly to `Downloads` and the completion toast includes a **Show file** action that highlights the `.md` file in Finder / Explorer / your file manager.

## Export options & live size preview

Every time the export modal opens, all three content controls default to **enabled**:

1. **Include tool calls** — tool inputs, outputs, errors, attachments, and nested sub-agent transcripts.
2. **Include reasoning** — model thinking blocks (`> _Reasoning_`) across turns.
3. **Compress output** — deterministic, zero-LLM deduplication and tool output compaction with three selectable modes:
   - **Lossless (default)** — 100% mathematically reversible compression.
   - **Smart** — `Lossless` plus CLI/test/search noise compaction with strict error preservation.
   - **Compact stubs** — `Smart` plus stubbing of superseded and unmodified exploratory file reads.

While the modal is open, the full unwindowed branch + sub-agent tree is parsed once into a `CanonicalTranscriptIR`. Toggling any checkbox or switching compression modes recomputes the exact UTF-8 byte count, BPE-calibrated lexical token estimate in thousands (`~Xk tokens`), and percentage saved against the raw uncompressed baseline synchronously in milliseconds.

## Deterministic compression modes

All exported service markers, anchors, reference links, delta headers, stubs, and metadata bullets are strictly in English regardless of UI locale, while user/assistant prose and source code are preserved verbatim.

### 1. `Lossless` (default)

Guarantees **100% bit-exact round-trip reconstruction** (`expandLosslessMarkdown` / `verifyLosslessRoundTrip`) from the `.md` file alone without external state:

- **OpenCode `Read` envelope canonicalization:** parses both v1 (`00001| ...`) and v2 (`<path>...<content>1: ...`) `Read` tool outputs into clean file text with inferred syntax highlighting (`ts`, `tsx`, `py`, `json`, etc.) while keeping malformed or directory outputs untouched.
- **Exact SHA-256 deduplication (`>= 64 B` net win):** identical tool outputs across turns and nested sub-agents are emitted once with an HTML anchor (`<a id="export-ref-cN"></a>`) and replaced later by `[↩ Identical to … · sha256:…](#export-ref-cN)`.
- **Line-range containment:** partial `Read` slices already present inside an earlier full `Read` of the same file become `[↩ Contained in … (slice start..end, K lines) · sha256:…](#export-ref-cN)`.
- **1-hop post-edit file deltas (`>= 20%` and `>= 96 B` net win):** re-reading a file after `Edit`/`Write` emits a compact `diff` hunk script (`@@ -start,del +start,add @@`) against the anchored base snapshot, verified by SHA-256 before emission.
- **Compact JSON inputs & `TOON-JSON v1` tables:** short single-object tool inputs (`<= 120` chars) render inline, and uniform JSON object arrays (`>= 3` rows, primitive cells, `>= 25%` and `>= 256 B` win) encode as lossless `toon` CSV-escaped tables.

### 2. `Smart`

Builds on `Lossless` for read-only CLI, search, and test commands while routing every tool call through `SafetyRouter`:

- **ANSI & progress noise stripping:** strips CSI/OSC escape sequences, braille spinner frames, and carriage-return (`\r`) progress-bar overwrites before deduplication so identical commands match cleanly.
- **Passing test run collapsing:** collapses long runs of passing test lines (`✓`, `PASS`, `ok`) into `[... collapsed N passing test lines ...]` while preserving suite summaries.
- **Search/log head+tail compaction:** compacts repetitive `grep`/`rg`/`glob` listings beyond 60 lines into head + tail excerpts with an explicit omitted-line counter.

### 3. `Compact stubs`

Builds on `Smart` using branch-wide file-history analysis:

- **Superseded `Read` snapshots:** earlier full reads of a file that is read again in full later in the branch collapse into a 1-line SHA-256 stub pointing to the latest turn.
- **Unmodified exploratory `Read`s (`> 24` lines):** full reads of files never modified (`edit`/`write`/`patch`/`apply_patch`/`multiedit`) anywhere in the branch collapse into a 1-line stub recording path, line range, byte size, and SHA-256.
- **Edited-file protection:** the latest full `Read` snapshot of every file modified in the branch is always preserved in full.

### Safety Router invariants

Across both `Smart` and `Compact stubs`, `classifyToolSafety` bypasses lossy compaction whenever a tool call:

- mutates files or state (`write`, `edit`, `multiedit`, `patch`, `apply_patch`, `notebookedit`, `todowrite`),
- has `state.status === "error"` or a non-zero exit code (`metadata.exit` / `exitCode`),
- contains stack traces, panics, `FAIL`/`ERROR` diagnostics, or compiler/typechecker errors (`error TS…`, `error[E…]`),
- contains PEM blocks, API keys/tokens, or SQL migration DDL.

Additionally, a document-level monotonicity guard ensures enabling compression never produces a larger file than the uncompressed transcript under the same filter checkboxes.

## What is included in the transcript

1. **Metadata header:** session title, message count, session ID, workspace path, parent session ID (when branched or spawned), created/updated UTC timestamps, models used, token/cost totals, omitted sections (when unchecked), and active compression summary.
2. **Complete unwindowed branch history:** fetches all cursor-paginated pages from the OpenCode engine (`limit = Infinity`) in chronological order while respecting active Undo (`session.revert`) branch boundaries.
3. **Model reasoning:** rendered as `> _Reasoning_` Markdown blockquotes in exact step order (when enabled).
4. **Tool calls (`🛠 <Tool>`):** JSON inputs, canonicalized/compacted outputs, partial live output and error blocks for failed commands, and tool attachments. Code fences automatically widen to 4+ backticks whenever tool input/output itself contains triple-backtick blocks.
5. **Sub-agent transcripts:** `task` tool calls that spawned child sessions (`state.metadata.sessionId`) recursively inline the child session's turns, reasoning, and tool calls inside `### ⤷ Subagent: …` / `### ⤶ End subagent` sections (with cycle protection).
6. **Tasks checklist:** active session todos (`[x]` / `[ ]`) when present.

## Upstream tracking

- OmniRush GUI feature request: [omnirush-ai/omnirush-gui#349](https://github.com/omnirush-ai/omnirush-gui/issues/349)
- Related OpenCode Desktop & CLI issues: [anomalyco/opencode#55542](https://github.com/anomalyco/opencode/issues/55542), [anomalyco/opencode#59904](https://github.com/anomalyco/opencode/issues/59904)
