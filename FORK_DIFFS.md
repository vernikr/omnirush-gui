# Fork differences

Compared with `omnirush-ai/omnirush-gui`:

- Intel-only macOS releases; app updates use this fork's GitHub feed.
- Upstream sync is maintained as a small, testable downstream patch stack.
- Reasoning/streaming render, transcript-progress, and chat-scroll performance optimizations; reduced Intel window blur.
- Find in rendered Markdown artifact previews. Prompt Select All excludes attachment chips, and focus returns after choosing files.
- Markdown code blocks follow dark/custom themes; GitHub favicons adapt to light/dark mode and other site icons retain transparency.
- Saved desktop UI zoom (`Cmd+` / `Cmd-` / `Cmd+0`) is restored immediately on launch and preserved across route transitions.
- Clicking a file referenced by name or partial path (`` `report.md` ``) in chat opens the shallowest matching workspace file ([omnirush-ai/omnirush-gui#351](https://github.com/omnirush-ai/omnirush-gui/issues/351)).
- Full session/branch Markdown (`.md`) export — including model reasoning, tool call inputs/outputs/errors, and nested sub-agent transcripts — via the session header, sidebar menu, Command Palette, and `/export [filename]` ([omnirush-ai/omnirush-gui#349](https://github.com/omnirush-ai/omnirush-gui/issues/349)).
- Quote chips preserve the editor scroll and caret, expand without swallowing adjacent text, start the reply on a blank line, and remain functional through undo ([omnirush-ai/omnirush-gui#354](https://github.com/omnirush-ai/omnirush-gui/issues/354)).
- Resizable workspace tree in artifact previews ([omnirush-ai/omnirush-gui#355](https://github.com/omnirush-ai/omnirush-gui/issues/355)).
- The session side-panel width is retained when reopened, and artifact headers show nested paths.
