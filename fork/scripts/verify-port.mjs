#!/usr/bin/env node
/**
 * Asserts that the port is intact after a sync.
 *
 * A patch can apply cleanly and still be wrong: upstream may have renamed a
 * file the port edits, or reintroduced a line the port replaces. These checks
 * fail the sync before anything is published, which is cheaper than shipping a
 * release whose Intel leg quietly disappeared.
 *
 * Usage:
 *   node fork/scripts/verify-port.mjs [--repo <owner/repo>] [--run-tests]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { portRepo } from "./lib/git.mjs";
import { UNTOUCHED_PATHS } from "./lib/patch-groups.mjs";

const RELEASE_WORKFLOW = ".github/workflows/release-desktop.yml";
const ELECTRON_DIR = "apps/desktop/electron";
const ENGINE_RELEASE = "apps/desktop/scripts/engine-release.json";

export function readFileSafe(path, io) {
  try {
    return io.read(path);
  } catch {
    return null;
  }
}

/**
 * Every check gets the repository contents through `io` so the tests can run
 * against fixtures in memory.
 */
export function portChecks({ repo, read, exists }) {
  const has = (path, needle) => (read(path) ?? "").includes(needle);
  return [
    {
      id: "intel-only-release",
      description: "the release workflow builds Intel macOS only",
      problems() {
        const workflow = read(RELEASE_WORKFLOW) ?? "";
        const missing = [];
        const matrix = workflow.match(/^\s+matrix:\s*\n\s+include:\s*\n([\s\S]*?)^\s+runs-on:/m)?.[1] ?? "";
        const legs = [...matrix.matchAll(/^\s+- name: (.+)$/gm)].map((match) => match[1].trim());
        if (!matrix) missing.push("release-desktop.yml has no release build matrix");
        if (legs.length !== 1 || legs[0] !== "macOS Intel") missing.push(`release matrix must contain only macOS Intel (found: ${legs.join(", ") || "none"})`);
        for (const [needle, label] of [
          ["runner: macos-15-intel", "the Intel runner"],
          ["builder_args: --mac --x64", "the --mac --x64 build"],
          ["update_manifest: latest-mac.yml", "the standard macOS update manifest"],
          ["feed_asset: latest-mac.yml", "the direct update-feed asset name"],
        ]) {
          if (!matrix.includes(needle)) missing.push(`release matrix is missing ${label}`);
        }
        if (workflow.includes("merge-mac-feed")) missing.push("the obsolete multi-architecture merge job is still present");
        if (!workflow.includes("for manifest in latest-mac.yml; do")) missing.push("publish verification still requires manifests for unsupported platforms");
        return missing;
      },
    },
    {
      id: "unsigned-build",
      description: "the build works without an Apple Developer ID",
      problems() {
        const workflow = read(RELEASE_WORKFLOW) ?? "";
        const missing = [];
        if (!workflow.includes("Resolve macOS signing")) missing.push("release-desktop.yml lost the signing decision step");
        if (workflow.includes("if: matrix.platform == 'macos'\n") && !workflow.includes("steps.signing.outputs.enabled")) {
          missing.push("a macOS step is gated on platform only, so it would run without a certificate");
        }
        if (/secrets\.MAC_CSC_LINK\s*!=/.test(workflow.replace(/^\s*#.*$/gm, "")) && /if:.*secrets\./.test(workflow)) {
          missing.push("an if: expression reads the secrets context, which Actions refuses to parse");
        }
        return missing;
      },
    },
    {
      id: "feed-coordinates",
      description: `the app reads releases from ${repo || "this repository"}`,
      problems() {
        if (!repo) return ["no repository to check against (--repo or fork/REPO)"];
        const missing = [];
        for (const file of ["main.mjs", "updater.mjs", "recovery.mjs"]) {
          const path = `${ELECTRON_DIR}/${file}`;
          const contents = read(path);
          if (contents === null) missing.push(`${path} is missing`);
          else if (!contents.includes(`github.com/${repo}/`)) missing.push(`${path} still points at another repository`);
        }
        const builder = read("apps/desktop/electron-builder.base.yml") ?? "";
        if (!builder.includes(`repo: ${repo.split("/")[1]}`)) missing.push("electron-builder.base.yml publishes to another repository");
        for (const file of ["updater.mjs", "recovery.mjs"]) {
          const contents = read(`${ELECTRON_DIR}/${file}`) ?? "";
          if (contents.includes("https://github.com/omnirush-ai/omnirush-gui/releases/")) {
            missing.push(`${file} still has a release-asset URL pointing at upstream`);
          }
        }
        return missing;
      },
    },
    {
      id: "engine-pins",
      description: "the pinned engine tarballs still come from upstream",
      problems() {
        const problems = [];
        const contents = read(ENGINE_RELEASE) ?? "";
        if (!contents.includes("omnirush-ai/omnirush-gui")) {
          problems.push(`${ENGINE_RELEASE} no longer names the upstream repository: the pinned engine tarballs live there`);
        }
        for (const path of UNTOUCHED_PATHS) {
          if (!exists(path)) problems.push(`${path} is missing`);
        }
        return problems;
      },
    },
    {
      id: "docs",
      description: "the docs describe the Intel build",
      problems() {
        const readme = read("README.md") ?? "";
        const updates = read("docs/updates.md") ?? "";
        const missing = [];
        if (!readme.includes("omnirush-mac-x64-")) missing.push("README.md has no Intel download row");
        if (!updates.includes("mac-x64")) missing.push("docs/updates.md does not mention the Intel feed");
        if (!exists("fork/README.md")) missing.push("fork/README.md is missing");
        return missing;
      },
    },
  ];
}

/** Runs `node --test` on the merge script, the way the release pipeline would. */
export function runPortTests(root) {
  try {
    execFileSync(process.execPath, ["--test", "scripts/release/merge-mac-update-manifests.test.mjs"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
    });
    return [];
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    return [`scripts/release/merge-mac-update-manifests.test.mjs fails:\n${output.split("\n").slice(-12).join("\n")}`];
  }
}

export function verifyPort({ root = process.cwd(), repo, runTests = false } = {}) {
  const io = {
    read: (path) => readFileSync(resolve(root, path), "utf8"),
    exists: (path) => existsSync(resolve(root, path)),
  };
  const target = repo ?? portRepo(root);
  const problems = [];
  const results = [];
  for (const check of portChecks({ repo: target, read: io.read, exists: io.exists })) {
    const found = check.problems();
    results.push({ id: check.id, description: check.description, ok: found.length === 0, problems: found });
    problems.push(...found.map((problem) => `[${check.id}] ${problem}`));
  }
  if (runTests) problems.push(...runPortTests(root).map((problem) => `[tests] ${problem}`));
  return { ok: problems.length === 0, problems, results };
}

function main() {
  const args = process.argv.slice(2);
  const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
  const runTests = args.includes("--run-tests");
  const result = verifyPort({ repo, runTests });
  for (const check of result.results) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.id.padEnd(18)} ${check.description}`);
    for (const problem of check.problems) console.log(`       ${problem}`);
  }
  if (!result.ok) {
    console.error(`\nThe port is incomplete (${result.problems.length} problem(s)).`);
    process.exit(1);
  }
  console.log("\nPort intact.");
}

if (process.argv[1] && process.argv[1].endsWith("verify-port.mjs")) main();
