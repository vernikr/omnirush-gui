// The port, split into patch files. Each group is a set of paths whose diff
// against upstream is stored under fork/patches; keeping them apart makes a
// conflict easy to locate ("0003 no longer applies" is one file, not five).
//
// Groups that only add files upstream does not have (fork/**, the sync
// workflow, the merge script) apply on any upstream commit. Groups that edit
// upstream files are the ones that can conflict when upstream moves.
export const PATCH_GROUPS = [
  {
    file: "0001-port-kit.patch",
    title: "the port kit: fork/ scripts, patches and the sync workflow",
    paths: ["fork", ":(exclude)fork/patches/0001-port-kit.patch", ".github/workflows/fork-sync.yml"],
    addsOnly: true,
  },
  {
    file: "0002-merge-mac-update-manifests.patch",
    title: "scripts/release/merge-mac-update-manifests.mjs: one macOS feed for both architectures",
    paths: [
      "scripts/release/merge-mac-update-manifests.mjs",
      "scripts/release/merge-mac-update-manifests.test.mjs",
    ],
    addsOnly: true,
  },
  {
    file: "0003-release-intel-macos-leg.patch",
    title: "release-desktop.yml: Intel-only build, conditional signing, direct macOS feed",
    paths: [".github/workflows/release-desktop.yml"],
    addsOnly: false,
  },
  {
    file: "0004-releases-from-this-fork.patch",
    title: "the app reads releases from this repository",
    paths: [
      "apps/desktop/electron",
      "apps/desktop/electron-builder.base.yml",
    ],
    addsOnly: false,
  },
  {
    file: "0005-docs-intel-macos.patch",
    title: "docs: Intel-only releases and update feed guidance",
    paths: ["README.md", "docs/updates.md", "RELEASING.md", "docs/intel-mac-plan.md"],
    addsOnly: false,
  },
  {
    file: "0006-thinking-stream-render-cost.patch",
    title: "a reasoning trace stops re-rendering itself as markdown on every frame",
    paths: [
      "apps/app/src/components/chat/reasoning-block.tsx",
      "apps/app/src/components/markdown",
      "apps/app/src/react-app/domains/session/status/session-progress.ts",
      "docs/intel-mac-performance.md",
      "evals/specs/streamed-markdown-answer.e2e.test.ts",
    ],
    addsOnly: false,
  },
  {
    file: "0007-mac-pane-blur-on-intel.patch",
    title: "the session pane drops its window-sized backdrop blur on Intel Macs",
    paths: [
      "apps/app/src/app/index.css",
      "apps/app/src/react-app/domains/session/chat/session-page.tsx",
    ],
    addsOnly: false,
  },
  {
    file: "0008-surface-markdown-dark-theme.patch",
    title: "Markdown preview code blocks follow the active dark or custom theme",
    paths: [
      "apps/app/src/app/index.css",
      "apps/app/src/components/markdown/markdown-primitive.ts",
      "apps/app/tests/markdown-code-block.test.ts",
    ],
    addsOnly: false,
  },
  {
    file: "0009-editor-scroll-find-select-all.patch",
    title: "remember editor position, find in both document panels, and select prompt text",
    paths: [
      "apps/app/src/react-app/domains/session/artifacts/artifact-panel.tsx",
      "apps/app/src/react-app/domains/session/artifacts/artifact-panel.css",
      "apps/app/src/react-app/domains/session/artifacts/artifact-find.ts",
      "apps/app/src/react-app/domains/session/artifacts/preview.tsx",
      "apps/app/src/react-app/domains/session/markdown-anchor.ts",
      "apps/app/src/react-app/domains/session/editor/editor-panel.tsx",
      "apps/app/src/react-app/domains/session/editor/editor-surface.tsx",
      "apps/app/src/react-app/domains/session/editor/editor.css",
      "apps/app/src/react-app/domains/session/editor/group2-editor.tsx",
      "apps/app/src/react-app/domains/session/editor/markdown-preview.tsx",
      "apps/app/src/react-app/domains/session/editor/scroll-position.ts",
      "apps/app/src/react-app/domains/session/surface/composer/composer.tsx",
      "apps/app/src/react-app/domains/session/surface/composer/editor.tsx",
      "apps/app/src/react-app/domains/session/surface/session-surface.tsx",
      "apps/app/tests/editor-scroll-position.test.ts",
      "apps/app/tests/composer-focus-continuity.test.tsx",
      "apps/app/tests/artifact-find.test.ts",
      "evals/specs/artifact-code-browser.e2e.test.ts",
      "evals/specs/attachment-upload-loading-state.e2e.test.ts",
      "apps/server/scripts/copy-shared-modules.mjs",
      "apps/desktop/electron/app-menu.mjs",
      "apps/desktop/electron/preload.mjs",
    ],
    addsOnly: false,
  },
  {
    file: "0010-upstream-compatibility.patch",
    title: "fork registry and upstream compatibility guidance",
    paths: ["AGENTS.md", "FORK_DIFFS.md"],
    addsOnly: false,
  },
  {
    file: "0011-github-favicon-theme.patch",
    title: "pasted links show theme-aware favicons (variant A)",
    paths: [
      "apps/app/src/lib/favicon.ts",
      "apps/app/src/components/markdown/markdown-primitive.ts",
      "apps/app/tests/favicon.test.ts",
    ],
    addsOnly: false,
  },
  {
    file: "0012-desktop-startup-zoom-restore.patch",
    title: "restore saved desktop UI zoom on launch and across hash routes",
    paths: [
      "apps/desktop/electron/preload.mjs",
      "apps/desktop/electron/main.mjs",
      "apps/desktop/electron/window-zoom.mjs",
      "apps/desktop/electron/window-zoom.test.mjs",
      "apps/app/src/app/lib/desktop.ts",
      "apps/app/src/react-app/shell/font-zoom.ts",
      "apps/app/tests/font-zoom.test.ts",
    ],
    addsOnly: false,
  },
  {
    file: "0013-session-markdown-export.patch",
    title: "export full session/branch (reasoning, tool calls, sub-agents) to Markdown",
    paths: [
      "packages/types/src/desktop-ipc.ts",
      "apps/desktop/electron/save-file.mjs",
      "apps/desktop/electron/save-file.test.mjs",
      "apps/app/src/app/lib/markdown-export",
      "apps/app/src/app/lib/session-markdown-export.ts",
      "apps/app/src/react-app/domains/session/commands/export-session-markdown-modal.tsx",
      "apps/app/src/react-app/domains/session/commands/export-session-markdown-store.ts",
      "apps/app/src/react-app/domains/session/commands/export-session-markdown.ts",
      "apps/app/src/react-app/domains/session/commands/session-command-controls.tsx",
      "apps/app/src/react-app/domains/session/commands/session-commands-store.ts",
      "apps/app/src/react-app/domains/session/sidebar/app-sidebar-provider.tsx",
      "apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx",
      "apps/app/src/react-app/shell/session-route.tsx",
      "apps/app/src/i18n/locales/en.ts",
      "apps/app/src/i18n/locales/zh.ts",
      "apps/app/src/i18n/locales/ru.ts",
      "apps/app/tests/export-session-markdown-modal.test.tsx",
      "apps/app/tests/markdown-export-lossless.test.ts",
      "apps/app/tests/markdown-export-smart-stubs.test.ts",
      "apps/app/tests/session-markdown-export.test.ts",
      "docs/session-markdown-export.md",
    ],
    addsOnly: false,
  },
];

/** Paths no group may touch: the engine tarballs are pinned in upstream releases. */
export const UNTOUCHED_PATHS = ["apps/desktop/scripts/engine-release.json"];
