# The Intel macOS port, as code

This fork exists for one reason: upstream `omnirush-ai/omnirush-gui` ships
macOS builds for Apple Silicon only, and this repository publishes an
`omnirush-mac-x64-<version>.dmg` next to them so the app runs natively on
Intel Macs.

Everything that makes this fork different from upstream lives in this folder:

```
fork/
  README.md              this file
  REPO                   the repository releases are published to
  UPSTREAM_BASE          the upstream commit the patches were generated against
  patches/               the port, as diffs against upstream main
  scripts/               sync, verification and patch maintenance
  tests/                 tests for those scripts
```

## How a release happens

`.github/workflows/fork-sync.yml` runs daily (05:23 UTC) and on demand:

1. **`sync-upstream.mjs`** fetches upstream `main`, resets the branch to it and
   applies `fork/patches/*.patch` with `git apply --index --3way`. The result is
   one commit per sync, carrying an `Upstream-Commit: <sha>` trailer. Nothing is
   ever rebased by hand, so there are no merge commits to resolve.
2. **`verify-port.mjs`** asserts the port is still intact — the Intel leg exists,
   both architectures share one `latest-mac.yml`, the build works without an
   Apple Developer ID, the update feed points at this repository, and the pinned
   engine tarballs still come from upstream. It also runs the merge script's
   tests.
3. If the resulting tree differs from what `main` holds, the branch is pushed
   and the next version is chosen: one patch above whichever is higher, the
   newest release of this fork or the newest upstream release
   (`next-version.mjs`). The update feed only moves forward, so a version must
   always be greater than the one installed apps already have.
4. The tag is pushed, which starts the **Desktop Release** workflow — the same
   one upstream uses, with a second macOS leg.

Run it by hand from Actions → **Sync upstream and release** → *Run workflow*.
`mode: check` syncs and verifies without publishing a release (it still pushes
the rebuilt branch, so `main` always tracks upstream plus the port).

Every step is a plain script, so the whole chain can be reproduced locally:

```bash
node fork/scripts/sync-upstream.mjs --upstream omnirush-ai/omnirush-gui --dry-run
node fork/scripts/verify-port.mjs --repo vernikr/omnirush-gui --run-tests
node --test fork/tests/
node fork/scripts/next-version.mjs --repo vernikr/omnirush-gui --published 3.6.0 --upstream 3.5.3
```

### Patches that contain patches

`0001-port-kit.patch` also carries the files in `fork/patches`, and a file
cannot contain itself: the copy inside it is one generation older than the file
itself. `sync-upstream.mjs` writes back the exact copies it applied, so the
branch holds the current generation and running the sync twice changes nothing
(`changed=false` on the second run).

### Why `main` is force-pushed

Every sync rebuilds `main` from upstream, so its history is rewritten each time
upstream moves. That is deliberate: the alternative is a merge conflict on the
same handful of files every few days. **Do not use GitHub's "Sync fork" button**
— it would add merge commits on top of a branch the automation replaces. Keep
your own work on other branches.

## When a patch stops applying

Upstream changes the files this port edits (the release workflow, the update
feed coordinates, the docs) a few times a month. When it changes the same lines,
`git apply --3way` cannot merge and the sync job fails. Nothing is pushed, and
the job opens (or comments on) an issue named *Port sync failed*.

To fix it:

```bash
git checkout main && git pull --rebase        # the last state the sync produced
# ... make the port correct again in the working tree ...
node fork/scripts/refresh-patches.mjs --base <upstream-sha>   # rewrite fork/patches
git add fork && git commit -m "port: follow upstream change X"
git push origin main
```

`--base` is the upstream commit the branch was rebuilt from (the
`Upstream-Commit` trailer of `HEAD`, printed by the sync job). Commit it: the
sync fetches that commit so `--3way` has the blobs it needs.

## What is in each patch

| Patch | Carries | Conflicts |
| --- | --- | --- |
| `0001-port-kit.patch` | this folder and the sync workflow | never — upstream has neither |
| `0002-merge-mac-update-manifests.patch` | `scripts/release/merge-mac-update-manifests.mjs` + tests | never — new files |
| `0003-release-intel-macos-leg.patch` | Intel matrix leg, conditional signing, per-arch manifest upload, the `merge-mac-feed` job | when upstream edits `release-desktop.yml` |
| `0004-releases-from-this-fork.patch` | update feed, release page and recovery URLs point here | when upstream edits those files |
| `0005-docs-intel-macos.patch` | README download row, `docs/updates.md`, `RELEASING.md` | when upstream edits those files |
| `0006-thinking-stream-render-cost.patch` | keep markdown rendering responsive during long runs | when upstream edits those files |
| `0007-mac-pane-blur-on-intel.patch` | reduce Intel Mac GPU load while streaming | when upstream edits those files |
| `0008-surface-markdown-dark-theme.patch` | Markdown preview code blocks follow dark/custom themes | when upstream edits markdown rendering or theme CSS |
| `0009-editor-scroll-find-select-all.patch` | find in artifact previews, prompt Select All, editor scroll | when upstream edits those files |
| `0010-upstream-compatibility.patch` | `AGENTS.md` and `FORK_DIFFS.md` | never — fork-only docs |
| `0011-github-favicon-theme.patch` | theme-aware GitHub favicon in link chips | when upstream edits `favicon.ts` |
| `0012-desktop-startup-zoom-restore.patch` | restore saved desktop UI zoom on launch and across `#` routes | when upstream edits desktop zoom or preload/main |
| `0013-session-markdown-export.patch` | export full session/branch (reasoning, tool calls, sub-agents) to `.md` | when upstream edits session commands, sidebar menu, or `session-route.tsx` |
| `0014-resolve-bare-file-names.patch` | a file named without its path (`` `report.md` ``) opens the highest workspace file with that name | when upstream edits the artifact resolve route or its journey spec |

## Secrets

- `FORK_SYNC_TOKEN` (optional): a PAT with `repo` + `workflow`. A tag pushed
  with the built-in `GITHUB_TOKEN` does not start another workflow, so without a
  PAT the job pushes the tag and then dispatches the release workflow
  explicitly. Both paths work; the PAT is the more direct one.
- `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY*` (optional): add them
  and the release signs and notarizes with a Developer ID. Without them the
  build is ad-hoc signed, which is why updates install through the DMG.

## Checks worth knowing

- `macos-15-intel` is GitHub's last x86_64 hosted image and is scheduled to be
  retired in **August 2027**. After that the Intel leg needs a self-hosted Intel
  runner or a universal package; `0003` carries the date in a comment.
- The app is on Electron 43, which needs macOS 12+. Electron 44 requires
  macOS 13, so an Electron major bump is a decision, not a dependency update.
- `apps/desktop/scripts/engine-release.json` deliberately still names upstream:
  the engine tarballs are pinned by sha256 in an upstream pre-release.
