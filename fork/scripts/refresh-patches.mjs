#!/usr/bin/env node
/**
 * Rewrites fork/patches from the working tree.
 *
 * Run this after fixing a patch that stopped applying: check out the branch the
 * sync produces, make the port correct again, then regenerate the patches and
 * commit them. The upstream commit the patches are generated against is written
 * to fork/UPSTREAM_BASE, which sync-upstream.mjs fetches so `git apply --3way`
 * has the blobs it needs.
 *
 * Usage:
 *   node fork/scripts/refresh-patches.mjs [--base <upstream-sha>] [--root <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { PATCH_GROUPS } from "./lib/patch-groups.mjs";
import { upstreamBase, upstreamCommitOf } from "./lib/git.mjs";

export function refreshPatches({ root = process.cwd(), base, log = console.log } = {}) {
  const target = base || upstreamCommitOf("HEAD", root) || upstreamBase(root);
  if (!target) {
    throw new Error("No base commit: pass --base <upstream-sha> or commit with an Upstream-Commit trailer.");
  }
  // The base goes on disk before the diffs are taken: fork/UPSTREAM_BASE is
  // itself part of the port, and writing it afterwards would leave the patches
  // one generation behind the tree they were generated from.
  writeFileSync(resolve(root, "fork/UPSTREAM_BASE"), `${target}\n`, "utf8");

  const written = [];
  for (const group of PATCH_GROUPS) {
    const diff = execFileSync(
      "git",
      ["diff", "--no-renames", "--binary", target, "--", ...group.paths],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (!diff.trim()) {
      log(`skipped ${group.file}: no changes against ${target.slice(0, 10)}`);
      continue;
    }
    const path = resolve(root, "fork/patches", group.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, diff, "utf8");
    written.push(group.file);
    log(`wrote fork/patches/${group.file} (${group.title})`);
  }
  log(`base recorded in fork/UPSTREAM_BASE: ${target}`);
  return { base: target, written };
}

function main() {
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
  const root = args.includes("--root") ? resolve(args[args.indexOf("--root") + 1]) : process.cwd();
  refreshPatches({ root, base });
}

if (process.argv[1] && process.argv[1].endsWith("refresh-patches.mjs")) main();
