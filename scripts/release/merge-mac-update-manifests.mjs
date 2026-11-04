#!/usr/bin/env node
/**
 * Merges the per-architecture macOS updater manifests a release build uploads
 * into the single `latest-mac.yml` installed apps read.
 *
 * Why this exists: electron-updater names its macOS channel file
 * `${channel}-mac.yml` and, unlike Linux, adds no architecture suffix to it
 * (electron-updater out/providers/Provider.js getChannelFilePrefix), so both
 * Apple Silicon and Intel builds share one manifest. Each build leg therefore
 * uploads its own manifest under a distinct name (latest-mac-arm64.yml,
 * latest-mac-x64.yml) to stop them from overwriting each other, and this
 * script combines them. MacUpdater picks the right zip by looking for "arm64"
 * in the file URL, and the app's own self-install path selects the entry whose
 * name carries `-<arch>-`, so one manifest listing both architectures is what
 * both expect.
 *
 * Usage:
 *   node scripts/release/merge-mac-update-manifests.mjs --release v3.6.0 \
 *     [--repo owner/repo] [--inputs latest-mac-arm64.yml,latest-mac-x64.yml] \
 *     [--output latest-mac.yml] [--dir <workdir>] [--keep-inputs] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_INPUTS = ["latest-mac-arm64.yml", "latest-mac-x64.yml"];
const DEFAULT_OUTPUT = "latest-mac.yml";
/** Both architectures a merged macOS feed must offer, matching the artifact names. */
export const MAC_ARCH_TOKENS = ["mac-arm64", "mac-x64"];
const BASE64_SHA512 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseArgs(argv) {
  const options = { inputs: DEFAULT_INPUTS, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      return argv[index];
    };
    if (arg === "--release") options.release = value();
    else if (arg === "--repo") options.repo = value();
    else if (arg === "--inputs") options.inputs = String(value()).split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--output") options.output = value();
    else if (arg === "--dir") options.dir = value();
    else if (arg === "--keep-inputs") options.keepInputs = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.release) {
    throw new Error("Usage: merge-mac-update-manifests.mjs --release <tag> [--repo <owner/repo>] [--inputs <a.yml,b.yml>] [--output <out.yml>] [--dir <dir>] [--keep-inputs] [--dry-run]");
  }
  if (options.inputs.length === 0) throw new Error("--inputs must name at least one manifest.");
  return options;
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseYamlScalar(value) {
  const unquoted = unquoteYamlScalar(value);
  return /^\d+$/.test(unquoted) ? Number(unquoted) : unquoted;
}

/** Minimal reader for the manifest shape electron-builder writes. */
export function parseUpdateManifest(raw, name = "manifest") {
  const parsed = { files: [] };
  let currentFile = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (key !== "files") parsed[key] = unquoteYamlScalar(value);
      currentFile = null;
      continue;
    }
    const fileStart = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileStart) {
      currentFile = { [fileStart[1]]: parseYamlScalar(fileStart[2]) };
      parsed.files.push(currentFile);
      continue;
    }
    const fileProp = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileProp && currentFile) currentFile[fileProp[1]] = parseYamlScalar(fileProp[2]);
  }
  if (!parsed.version) throw new Error(`${name} has no version.`);
  if (parsed.files.length === 0) throw new Error(`${name} lists no files.`);
  return parsed;
}

function quoteYamlScalar(value) {
  const string = String(value ?? "");
  if (!string || /[:#[\]{}&,*!|>'"%@`\s]/.test(string)) return `'${string.replace(/'/g, "''")}'`;
  return string;
}

export function stringifyUpdateManifest(manifest) {
  const lines = [`version: ${quoteYamlScalar(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    lines.push(`  - url: ${quoteYamlScalar(file.url)}`);
    for (const [key, value] of Object.entries(file)) {
      if (key === "url") continue;
      lines.push(`    ${key}: ${typeof value === "number" ? value : quoteYamlScalar(value)}`);
    }
  }
  if (manifest.releaseDate) lines.push(`releaseDate: ${quoteYamlScalar(manifest.releaseDate)}`);
  return `${lines.join("\n")}\n`;
}

/** arm64 first, then x64, then anything else; zip before the rest inside an arch. */
export function sortFiles(files) {
  const rank = (url) => {
    const value = String(url || "");
    if (value.includes("arm64")) return 0;
    if (value.includes("x64") || value.includes("x86_64")) return 1;
    return 2;
  };
  return [...files].sort((left, right) => {
    const byRank = rank(left.url) - rank(right.url);
    if (byRank !== 0) return byRank;
    const leftExt = /\.[A-Za-z0-9]+$/.exec(String(left.url || ""))?.[0] ?? "";
    const rightExt = /\.[A-Za-z0-9]+$/.exec(String(right.url || ""))?.[0] ?? "";
    if (leftExt === ".zip" && rightExt !== ".zip") return -1;
    if (rightExt === ".zip" && leftExt !== ".zip") return 1;
    return String(left.url || "").localeCompare(String(right.url || ""));
  });
}

/**
 * Combines per-architecture manifests. The result carries `files` only (no
 * top-level `path`/`sha512`): electron-updater resolves updates through
 * `files`, and both the app's manifest reader and MacUpdater pick the entry
 * for the running architecture. A single top-level `path` would point at one
 * architecture and mislead anything that still reads it.
 */
export function mergeMacManifests(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("No manifests to merge.");
  const version = entries[0].manifest.version;
  const filesByUrl = new Map();
  const releaseDates = [];
  for (const { name, manifest } of entries) {
    if (String(manifest.version) !== String(version)) {
      throw new Error(`${name} is at version ${manifest.version} while ${entries[0].name} is at ${version}; refusing to merge.`);
    }
    for (const file of manifest.files) {
      if (!file?.url) throw new Error(`${name} contains a file entry without url.`);
      const previous = filesByUrl.get(file.url);
      if (previous && (previous.file.sha512 !== file.sha512 || previous.file.size !== file.size)) {
        throw new Error(`${file.url} is listed with different checksums in ${previous.name} and ${name}.`);
      }
      // The source manifest is tracked beside the entry, never inside it: the
      // merged feed must hold only what electron-builder writes.
      filesByUrl.set(file.url, { file: { ...file }, name });
    }
    if (manifest.releaseDate) releaseDates.push(manifest.releaseDate);
  }
  const merged = { version, files: sortFiles([...filesByUrl.values()].map((entry) => entry.file)) };
  if (releaseDates.length) merged.releaseDate = releaseDates.sort().at(-1);
  return merged;
}

/** What an installed app needs from the merged feed; throws with every problem found. */
export function validateMergedMacManifest(merged, outputName = DEFAULT_OUTPUT) {
  const errors = [];
  const urls = merged.files.map((file) => String(file?.url || ""));
  for (const arch of MAC_ARCH_TOKENS) {
    if (!urls.some((url) => url.includes(arch))) errors.push(`${outputName} is missing ${arch} artifacts.`);
  }
  for (const url of urls) {
    if (!url.startsWith("omnirush-") || /\//.test(url)) {
      errors.push(`${outputName} lists ${JSON.stringify(url)}, which is not a plain omnirush-* file name.`);
    }
  }
  for (const file of merged.files) {
    if (typeof file.sha512 !== "string" || !BASE64_SHA512.test(file.sha512) || Buffer.from(file.sha512, "base64").length !== 64) {
      errors.push(`${file.url} must carry a base64 sha512.`);
    }
    if (!Number.isInteger(file.size) || file.size <= 0) {
      errors.push(`${file.url} must carry a positive integer size.`);
    }
  }
  if (new Set(urls).size !== urls.length) errors.push(`${outputName} lists the same file twice.`);
  if (errors.length) throw new Error(errors.join("\n"));
  return merged;
}

function defaultGh(args) {
  const result = spawnSync("gh", args, { stdio: "inherit", encoding: "utf8" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return "";
}

/**
 * Downloads `inputs` from the release, merges them into `output`, uploads the
 * result and (unless --keep-inputs) removes the per-architecture manifests.
 * `gh`, `readFile` and `writeFile` are injectable so the tests cover the whole
 * plan without touching GitHub.
 */
export function runMerge(options, io = {}) {
  const gh = io.gh ?? defaultGh;
  const readFile = io.readFile ?? ((file) => readFileSync(file, "utf8"));
  const writeFile = io.writeFile ?? ((file, contents) => writeFileSync(file, contents, "utf8"));
  const log = io.log ?? console.log;
  const {
    release,
    repo = process.env.GITHUB_REPOSITORY,
    inputs = DEFAULT_INPUTS,
    output = DEFAULT_OUTPUT,
    dir = mkdtempSync(join(tmpdir(), "merge-mac-")),
    keepInputs = false,
    dryRun = false,
  } = options;
  if (!repo) throw new Error("A repository is required (--repo or GITHUB_REPOSITORY).");

  const entries = [];
  for (const name of inputs) {
    if (!dryRun) gh(["release", "download", release, "--repo", repo, "--dir", dir, "--pattern", name]);
    const raw = dryRun && io.contents ? io.contents[name] : readFile(join(dir, name));
    entries.push({ name, manifest: parseUpdateManifest(raw, name) });
  }

  const merged = validateMergedMacManifest(mergeMacManifests(entries), output);
  const outputPath = join(dir, output);
  writeFile(outputPath, stringifyUpdateManifest(merged));
  log(`${output}: version ${merged.version}, ${merged.files.length} files (${merged.files.map((file) => file.url).join(", ")})`);

  if (dryRun) return { merged, outputPath, uploaded: [], deleted: [] };
  gh(["release", "upload", release, `${outputPath}#${output}`, "--repo", repo, "--clobber"]);
  const deleted = [];
  if (!keepInputs) {
    for (const name of inputs) {
      if (name === output) continue;
      gh(["release", "delete-asset", release, name, "--repo", repo, "--yes"]);
      deleted.push(name);
    }
  }
  return { merged, outputPath, uploaded: [output], deleted };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  try {
    const result = runMerge(options);
    console.log(JSON.stringify({ ok: true, manifest: result.outputPath, version: result.merged.version, files: result.merged.files.map((file) => file.url) }, null, 2));
  } catch (error) {
    console.error(`Merging the macOS update feed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
