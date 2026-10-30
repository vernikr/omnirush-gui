// Shared helpers for the port scripts. Everything the fork automation needs to
// drive git lives here so the scripts stay readable and testable.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Runs a command and returns its stdout, throwing with the output on failure. */
export function run(command, args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const result = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return result.trim();
}

/** The repository this port publishes to (fork/REPO), else $GITHUB_REPOSITORY. */
export function portRepo(root = process.cwd()) {
  const file = resolve(root, "fork/REPO");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return process.env.GITHUB_REPOSITORY ?? "";
}

/** The upstream commit the patches in fork/patches were generated against. */
export function upstreamBase(root = process.cwd()) {
  const file = resolve(root, "fork/UPSTREAM_BASE");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return "";
}

/** Reads the Upstream-Commit trailer off a commit message. */
export function upstreamCommitOf(ref, root = process.cwd()) {
  try {
    const message = run("git", ["log", "-1", "--format=%B", ref], { cwd: root });
    return /^Upstream-Commit:\s*([0-9a-f]{7,40})$/im.exec(message)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function patchNames(root = process.cwd()) {
  const dir = resolve(root, "fork/patches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".patch"))
    .sort();
}
