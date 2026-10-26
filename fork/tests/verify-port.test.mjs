import assert from "node:assert/strict";
import { test } from "node:test";
import { portChecks } from "../scripts/verify-port.mjs";

const REPO = "vernikr/omnirush-gui";

/** A repository in which the port is intact; tests break one thing at a time. */
function portedRepo(overrides = {}) {
  const files = {
    ".github/workflows/release-desktop.yml": [
      "  build:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - name: macOS Intel",
      "            runner: macos-15-intel",
      "            builder_args: --mac --x64",
      "            update_manifest: latest-mac.yml",
      "            feed_asset: latest-mac.yml",
      "    runs-on: ${{ matrix.runner }}",
      "          for manifest in latest-mac.yml; do",
      "  - name: Resolve macOS signing",
      "    if: matrix.platform == 'macos' && steps.signing.outputs.enabled == 'true'",
    ].join("\n"),
    "scripts/release/merge-mac-update-manifests.mjs": "// merge\n",
    "scripts/release/merge-mac-update-manifests.test.mjs": "// tests\n",
    "apps/desktop/electron/main.mjs": `const U = "https://github.com/${REPO}/releases/latest/download";\n`,
    "apps/desktop/electron/updater.mjs": `export const FEED = "https://github.com/${REPO}/releases/latest/download";\n`,
    "apps/desktop/electron/recovery.mjs": `const baseUrl = \`https://github.com/${REPO}/releases/download/v\`;\n`,
    "apps/desktop/electron-builder.base.yml": "publish:\n  - provider: github\n    owner: vernikr\n    repo: omnirush-gui\n",
    "apps/desktop/scripts/engine-release.json": '{"repo":"omnirush-ai/omnirush-gui"}\n',
    "README.md": "| macOS, Intel | `omnirush-mac-x64-<version>.dmg` |\n",
    "docs/updates.md": "| macOS Intel | `omnirush-mac-x64-<version>.zip` | `latest-mac.yml` |\n",
    "fork/README.md": "# port kit\n",
    ...overrides,
  };
  return {
    read: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    exists: (path) => files[path] !== undefined,
  };
}

function problemsFor(overrides = {}, repo = REPO) {
  const io = portedRepo(overrides);
  return portChecks({ repo, read: io.read, exists: io.exists })
    .flatMap((check) => check.problems().map((problem) => `[${check.id}] ${problem}`));
}

test("a ported repository has no problems", () => {
  assert.deepEqual(problemsFor(), []);
});

test("catches non-Intel release matrix legs", () => {
  const problems = problemsFor({
    ".github/workflows/release-desktop.yml": [
      "  build:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - name: macOS Intel",
      "            runner: macos-15-intel",
      "            builder_args: --mac --x64",
      "            update_manifest: latest-mac.yml",
      "            feed_asset: latest-mac.yml",
      "          - name: Windows x64",
      "            runner: windows-2022",
      "    runs-on: ${{ matrix.runner }}",
    ].join("\n"),
  });
  assert.ok(problems.some((problem) => problem.includes("must contain only macOS Intel")));
});

test("catches an if: expression that reads the secrets context", () => {
  const problems = problemsFor({
    ".github/workflows/release-desktop.yml": [
      "          - name: macOS Intel",
      "            runner: macos-15-intel",
      "            builder_args: --mac --x64",
      "            update_manifest: latest-mac.yml",
      "            feed_asset: latest-mac.yml",
      "    runs-on: ${{ matrix.runner }}",
      "  - name: Prepare macOS signing",
      "    if: matrix.platform == 'macos' && secrets.MAC_CSC_LINK != ''",
    ].join("\n"),
  });
  assert.ok(problems.some((problem) => problem.includes("secrets context")));
});

test("catches release coordinates that point back at upstream", () => {
  const problems = problemsFor({
    "apps/desktop/electron/updater.mjs": 'export const FEED = "https://github.com/omnirush-ai/omnirush-gui/releases/latest/download";\n',
  });
  assert.ok(problems.some((problem) => problem.includes("updater.mjs still points at another repository")));
});

test("catches stale upstream asset URLs even when the latest feed is forked", () => {
  const problems = problemsFor({
    "apps/desktop/electron/updater.mjs": [
      'export const FEED = "https://github.com/vernikr/omnirush-gui/releases/latest/download";',
      'return "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3";',
    ].join("\n"),
  });
  assert.ok(problems.some((problem) => problem.includes("updater.mjs still has a release-asset URL pointing at upstream")));
});

test("insists the pinned engine stays on upstream", () => {
  const problems = problemsFor({
    "apps/desktop/scripts/engine-release.json": `{"repo":"${REPO}"}\n`,
  });
  assert.ok(problems.some((problem) => problem.includes("engine tarballs")));
});
