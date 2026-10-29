# Fork differences

Compared with `omnirush-ai/omnirush-gui`:

- Intel-only macOS releases; app updates use this fork's GitHub feed.
- Upstream sync is maintained as a small, testable downstream patch stack.
- Reasoning/streaming render and transcript-progress performance optimizations; reduced Intel window blur.
- Find in artifact previews; prompt Select All excludes attachment chips; editor scroll position is preserved.
- Markdown code blocks follow dark/custom themes.
- Saved desktop UI zoom (`Cmd+` / `Cmd-` / `Cmd+0`) is restored immediately on launch and preserved across route transitions.
- Full session/branch Markdown (`.md`) export — including model reasoning, tool call inputs/outputs/errors, and nested sub-agent transcripts — via the session header, sidebar menu, Command Palette, and `/export [filename]` ([omnirush-ai/omnirush-gui#349](https://github.com/omnirush-ai/omnirush-gui/issues/349)).
