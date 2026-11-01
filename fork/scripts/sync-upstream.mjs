#!/usr/bin/env node
/**
 * Rebuilds a branch as `upstream main + the patches in fork/patches`.
 *
 * The port is never rebased by hand: every sync checks out the upstream commit,
 * applies the patches with `git apply --index --3way` (so a patch whose context
 * moved still merges when it can) and commits the result once. If a patch
 * cannot be applied the command fails with the patch name and the conflict, and
 * the branch is left unpushed — see fork/README.md, "When a patch stops
 * applying".
 *
 * Usage:
 *   node fork/scripts/sync-upstream.mjs --upstream <owner/repo> [--ref main]
 *     [--branch main] [--repo <owner/repo>] [--dry-run]
 *
 * Writes `changed`, `upstream`, `base`, `head` and `dry_run` to $GITHUB_OUTPUT
 * when it runs in Actions.
 */
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PATCH_GROUPS } from "./lib/patch-groups.mjs";
import { patchNames, run, upstreamBase } from "./lib/git.mjs";

export function upstreamFetchSpec(ref) {
  const sourceRef = ref.startsWith("refs/")
    ? ref
    : /^v\d/.test(ref)
      ? `refs/tags/${ref}`
      : `refs/heads/${ref}`;
  if (!sourceRef.startsWith("refs/heads/") && !sourceRef.startsWith("refs/tags/")) {
    throw new Error(`Unsupported upstream ref: ${ref}`);
  }
  const trackingRef = sourceRef.startsWith("refs/heads/")
    ? sourceRef.replace("refs/heads/", "refs/remotes/upstream/")
    : sourceRef.replace("refs/tags/", "refs/remotes/upstream/tags/");
  return { sourceRef, trackingRef };
}

export function parseArgs(argv) {
  const options = { ref: "main", branch: "main", root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      return argv[index];
    };
    if (arg === "--upstream") options.upstream = value();
    else if (arg === "--ref") options.ref = value();
    else if (arg === "--branch") options.branch = value();
    else if (arg === "--repo") options.repo = value();
    else if (arg === "--root") options.root = resolve(value());
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.upstream) throw new Error("--upstream <owner/repo> is required.");
  return options;
}

function git(args, options) {
  return run("git", args, { ...options });
}

function gitQuiet(args, options) {
  try {
    return { ok: true, output: git(args, options) };
  } catch (error) {
    return { ok: false, output: `${error?.stdout ?? ""}${error?.stderr ?? error?.message ?? ""}`.trim() };
  }
}

export function syncUpstream(options, io = {}) {
  const log = io.log ?? console.log;
  const {
    upstream,
    ref,
    branch,
    root,
    dryRun = false,
  } = options;
  const cwd = { cwd: root };

  // 1. Where upstream is now.
  const remotes = git(["remote"], cwd).split("\n").map((value) => value.trim());
  if (!remotes.includes("upstream")) git(["remote", "add", "upstream", `https://github.com/${upstream}.git`], cwd);
  const { sourceRef, trackingRef } = upstreamFetchSpec(ref);
  // Fork releases reuse upstream version tags, so `git fetch --tags` collides
  // with tags already created by this repository. Fetch only the requested
  // branch or tag into a namespaced remote-tracking ref instead.
  git(["fetch", "--no-tags", "upstream", `${sourceRef}:${trackingRef}`], cwd);
  const upstreamSha = git(["rev-parse", `${trackingRef}^{commit}`], cwd);

  // The 3-way fallback needs the blobs the patches were generated from.
  const base = upstreamBase(root);
  if (base) gitQuiet(["fetch", "upstream", "--depth=1", base], cwd);

  const previousSha = gitQuiet(["rev-parse", branch], cwd).ok ? git(["rev-parse", branch], cwd) : "";
  const previousTree = previousSha ? git(["rev-parse", `${branch}^{tree}`], cwd) : "";

  // 2. Rebuild the branch from the upstream commit.
  const names = patchNames(root);
  if (dryRun) {
    log(`[dry-run] would reset ${branch} to ${upstreamSha} and apply ${names.length} patches`);
    return { upstreamSha, base, previousSha, headSha: "", changed: false, dryRun: true, applied: [] };
  }

  // The patches live in the tree we are about to replace, so keep a copy
  // outside the repository and apply them from there.
  const stagingDir = mkdtempSync(join(tmpdir(), "fork-patches-"));
  try {
    for (const name of names) cpSync(join(root, "fork", "patches", name), join(stagingDir, name));

    // 2. Rebuild the branch from the upstream commit.
    git(["checkout", "-B", branch, upstreamSha], cwd);

    // 3. Apply the port.
    const applied = [];
    for (const name of names) {
      const patchPath = `fork/patches/${name}`;
      const group = PATCH_GROUPS.find((entry) => entry.file === name);
      // Add-only kits have no upstream context to merge. Applying those
      // directly also handles new files when the release base is a shallow
      // checkout; modified upstream files still use the 3-way fallback.
      const applyArgs = group?.addsOnly
        ? ["apply", "--index", "--whitespace=nowarn", join(stagingDir, name)]
        : ["apply", "--index", "--3way", "--whitespace=nowarn", join(stagingDir, name)];
      const result = gitQuiet(applyArgs, cwd);
      if (!result.ok) {
        throw new Error(
          `${patchPath} does not apply to ${upstream}/${ref} (${upstreamSha}).\n` +
          `${group ? `It carries: ${group.title}.\n` : ""}` +
          `Fix it on a scratch branch, then run node fork/scripts/refresh-patches.mjs.\n\n${result.output}`,
        );
      }
      applied.push(name);
      log(`applied ${patchPath}`);
    }

    // A patch cannot contain itself, so the kit patch carries the previous
    // generation of these files. Put back the copies that were just applied:
    // then the branch holds the current generation and the next sync is a
    // no-op instead of walking the kit backwards one generation per run.
    const patchesDir = join(root, "fork", "patches");
    if (existsSync(patchesDir)) {
      for (const name of names) cpSync(join(stagingDir, name), join(patchesDir, name));
      git(["add", "--", "fork/patches"], cwd);
    }

    // 4. One commit that records what it is built on.
    const staged = git(["diff", "--cached", "--name-only"], cwd);
    if (!staged) {
      log(`nothing to commit: ${upstreamSha} plus the port is what ${branch} already holds`);
      return { upstreamSha, base, previousSha, headSha: previousSha, changed: false, dryRun: false, applied };
    }
    git(
      ["commit", "-m", `Apply the Intel macOS port on ${upstream}/${ref}`, "-m", `Upstream-Commit: ${upstreamSha}`],
      { ...cwd, env: { GIT_AUTHOR_NAME: "fork-port[bot]", GIT_AUTHOR_EMAIL: "fork-port[bot]@users.noreply.github.com", GIT_COMMITTER_NAME: "fork-port[bot]", GIT_COMMITTER_EMAIL: "fork-port[bot]@users.noreply.github.com" } },
    );
    const headSha = git(["rev-parse", "HEAD"], cwd);
    const headTree = git(["rev-parse", "HEAD^{tree}"], cwd);
    log(`committed ${headSha} (${staged.split("\n").length} files changed)`);
    return {
      upstreamSha,
      base,
      previousSha,
      headSha,
      changed: headTree !== previousTree,
      dryRun: false,
      applied,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = syncUpstream(options);
  const output = process.env.GITHUB_OUTPUT;
  const lines = [
    `upstream=${result.upstreamSha}`,
    `base=${result.base}`,
    `head=${result.headSha}`,
    `changed=${result.changed}`,
    `dry_run=${result.dryRun}`,
  ];
  if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
  if (result.applied?.length) console.log(`Applied ${result.applied.length} patches on ${result.upstreamSha}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
