#!/usr/bin/env node
/**
 * Picks the next version for a release of this fork.
 *
 * The desktop update feed only moves forward: an installed app takes a version
 * higher than its own from the release marked Latest
 * (scripts/release/latest-guard.mjs). So the next version is one patch above
 * whichever is higher — the newest release of this fork, or the newest upstream
 * release, so the fork never falls behind a version users may have seen.
 *
 * Usage:
 *   node fork/scripts/next-version.mjs [--repo <owner/repo>] [--upstream X.Y.Z]
 *     [--published 3.6.0,3.6.1] [--format version|tag]
 */
import { execFileSync } from "node:child_process";
import {
  bumpStableVersion,
  compareStableVersions,
  highestStableVersion,
  parseStableVersion,
  stableVersionFromTag,
} from "../../scripts/release/versions.mjs";

export const FALLBACK_VERSION = "3.6.0";

export function nextVersion({ published = [], upstream = null } = {}) {
  const ours = highestStableVersion(published.filter((value) => parseStableVersion(value)));
  const theirs = upstream && parseStableVersion(upstream) ? upstream : null;
  if (!ours && !theirs) return FALLBACK_VERSION;
  if (!ours) return bumpStableVersion(theirs, "patch");
  if (!theirs) return bumpStableVersion(ours, "patch");
  return bumpStableVersion(compareStableVersions(ours, theirs) >= 0 ? ours : theirs, "patch");
}

/** Versions this fork has already published, read through the gh CLI. */
export function readPublished(repo) {
  try {
    const raw = execFileSync("gh", ["api", "--paginate", `repos/${repo}/releases`, "--jq", ".[].tag_name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.split("\n").map((tag) => stableVersionFromTag(tag)).filter(Boolean);
  } catch (error) {
    // Returning an empty list here would pick the fallback version and tag a
    // release that already exists, so the caller has to hear about it.
    console.error(`could not read the releases of ${repo}: ${error?.message ?? error}`);
    return null;
  }
}

export function parseArgs(argv) {
  const options = { format: "version" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      return argv[index];
    };
    if (arg === "--repo") options.repo = value();
    else if (arg === "--upstream") options.upstream = value();
    else if (arg === "--published") options.published = String(value()).split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--format") options.format = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const published = options.published ?? (options.repo ? readPublished(options.repo) : []);
  if (!published) throw new Error(`Refusing to guess a version: the releases of ${options.repo} are unreadable.`);
  const version = nextVersion({ published, upstream: options.upstream ?? null });
  console.log(options.format === "tag" ? `v${version}` : version);
}

if (process.argv[1] && process.argv[1].endsWith("next-version.mjs")) main();
