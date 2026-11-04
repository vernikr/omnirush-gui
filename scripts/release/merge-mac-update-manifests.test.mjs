import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeMacManifests,
  parseArgs,
  parseUpdateManifest,
  runMerge,
  stringifyUpdateManifest,
  validateMergedMacManifest,
} from "./merge-mac-update-manifests.mjs";

const SHA512_A = "A".repeat(86) + "==";
const SHA512_B = "B".repeat(86) + "==";
const SHA512_C = "C".repeat(86) + "==";
const SHA512_D = "D".repeat(86) + "==";

const arm64Manifest = `version: 3.6.0
files:
  - url: omnirush-mac-arm64-3.6.0.zip
    sha512: ${SHA512_A}
    size: 111
  - url: omnirush-mac-arm64-3.6.0.dmg
    sha512: ${SHA512_B}
    size: 222
path: omnirush-mac-arm64-3.6.0.zip
sha512: ${SHA512_A}
releaseDate: "2026-10-17T10:00:00.000Z"
`;

const x64Manifest = `version: 3.6.0
files:
  - url: omnirush-mac-x64-3.6.0.zip
    sha512: ${SHA512_C}
    size: 333
  - url: omnirush-mac-x64-3.6.0.dmg
    sha512: ${SHA512_D}
    size: 444
path: omnirush-mac-x64-3.6.0.zip
sha512: ${SHA512_C}
releaseDate: "2026-10-17T10:05:00.000Z"
`;

test("reads the manifest shape electron-builder writes", () => {
  const manifest = parseUpdateManifest(arm64Manifest, "latest-mac-arm64.yml");
  assert.equal(manifest.version, "3.6.0");
  assert.deepEqual(manifest.files.map((file) => file.url), [
    "omnirush-mac-arm64-3.6.0.zip",
    "omnirush-mac-arm64-3.6.0.dmg",
  ]);
  assert.equal(manifest.files[0].size, 111);
  assert.equal(manifest.releaseDate, "2026-10-17T10:00:00.000Z");
});

test("rejects a manifest without files", () => {
  assert.throws(() => parseUpdateManifest("version: 3.6.0\n", "latest-mac-arm64.yml"), /lists no files/);
});

test("merges both architectures with arm64 first and the zip ahead of the dmg", () => {
  const merged = mergeMacManifests([
    { name: "latest-mac-x64.yml", manifest: parseUpdateManifest(x64Manifest) },
    { name: "latest-mac-arm64.yml", manifest: parseUpdateManifest(arm64Manifest) },
  ]);
  assert.equal(merged.version, "3.6.0");
  assert.deepEqual(merged.files.map((file) => file.url), [
    "omnirush-mac-arm64-3.6.0.zip",
    "omnirush-mac-arm64-3.6.0.dmg",
    "omnirush-mac-x64-3.6.0.zip",
    "omnirush-mac-x64-3.6.0.dmg",
  ]);
  assert.equal(merged.releaseDate, "2026-10-17T10:05:00.000Z");
  // A single top-level path would point at one architecture only.
  assert.equal(merged.path, undefined);
  assert.equal(merged.sha512, undefined);
});

test("refuses to merge manifests from different versions", () => {
  const older = parseUpdateManifest(arm64Manifest.replace("3.6.0", "3.5.2"));
  assert.throws(
    () => mergeMacManifests([
      { name: "latest-mac-arm64.yml", manifest: older },
      { name: "latest-mac-x64.yml", manifest: parseUpdateManifest(x64Manifest) },
    ]),
    /refusing to merge/,
  );
});

test("refuses a feed that offers only one architecture", () => {
  const merged = mergeMacManifests([{ name: "latest-mac-arm64.yml", manifest: parseUpdateManifest(arm64Manifest) }]);
  assert.throws(() => validateMergedMacManifest(merged), /missing mac-x64 artifacts/);
});

test("refuses entries without a usable sha512 or size", () => {
  const merged = mergeMacManifests([
    { name: "latest-mac-arm64.yml", manifest: parseUpdateManifest(arm64Manifest) },
    { name: "latest-mac-x64.yml", manifest: parseUpdateManifest(x64Manifest) },
  ]);
  merged.files[0].sha512 = "not-base64";
  assert.throws(() => validateMergedMacManifest(merged), /must carry a base64 sha512/);
});

test("keeps bookkeeping keys out of the merged entries", () => {
  const merged = mergeMacManifests([
    { name: "latest-mac-arm64.yml", manifest: parseUpdateManifest(arm64Manifest) },
    { name: "latest-mac-x64.yml", manifest: parseUpdateManifest(x64Manifest) },
  ]);
  for (const file of merged.files) {
    assert.deepEqual(Object.keys(file).sort(), ["sha512", "size", "url"]);
  }
  assert.doesNotMatch(stringifyUpdateManifest(merged), /name:/);
});

test("renders a manifest electron-updater can read", () => {
  const merged = validateMergedMacManifest(mergeMacManifests([
    { name: "latest-mac-arm64.yml", manifest: parseUpdateManifest(arm64Manifest) },
    { name: "latest-mac-x64.yml", manifest: parseUpdateManifest(x64Manifest) },
  ]));
  const roundTripped = parseUpdateManifest(stringifyUpdateManifest(merged), "latest-mac.yml");
  assert.equal(roundTripped.version, merged.version);
  assert.deepEqual(roundTripped.files.map((file) => file.url), merged.files.map((file) => file.url));
  assert.equal(roundTripped.files[2].sha512, SHA512_C);
});

test("uploads the merged feed under its own name and drops the per-arch inputs", () => {
  const calls = [];
  const written = {};
  const result = runMerge(
    { release: "v3.6.0", repo: "vernikr/omnirush-gui", dir: "/tmp/merge" },
    {
      gh: (args) => calls.push(args),
      readFile: (file) => (file.endsWith("latest-mac-arm64.yml") ? arm64Manifest : x64Manifest),
      writeFile: (file, contents) => {
        written[file] = contents;
      },
      log: () => {},
    },
  );
  assert.equal(result.merged.files.length, 4);
  assert.ok(written["/tmp/merge/latest-mac.yml"].startsWith("version: 3.6.0\nfiles:\n  - url: omnirush-mac-arm64-3.6.0.zip"));
  const upload = calls.find((args) => args[0] === "release" && args[1] === "upload");
  assert.deepEqual(upload.slice(2), [
    "v3.6.0",
    "/tmp/merge/latest-mac.yml#latest-mac.yml",
    "--repo",
    "vernikr/omnirush-gui",
    "--clobber",
  ]);
  assert.deepEqual(calls.filter((args) => args[1] === "delete-asset").map((args) => args[3]), [
    "latest-mac-arm64.yml",
    "latest-mac-x64.yml",
  ]);
});

test("--keep-inputs leaves the per-architecture manifests on the release", () => {
  const calls = [];
  runMerge(
    { release: "v3.6.0", repo: "vernikr/omnirush-gui", dir: "/tmp/merge", keepInputs: true },
    {
      gh: (args) => calls.push(args),
      readFile: (file) => (file.endsWith("latest-mac-arm64.yml") ? arm64Manifest : x64Manifest),
      writeFile: () => {},
      log: () => {},
    },
  );
  assert.equal(calls.filter((args) => args[1] === "delete-asset").length, 0);
});

test("--dry-run merges without touching the release", () => {
  const calls = [];
  const result = runMerge(
    { release: "v3.6.0", repo: "vernikr/omnirush-gui", dir: "/tmp/merge", dryRun: true },
    {
      gh: (args) => calls.push(args),
      readFile: (file) => (file.endsWith("latest-mac-arm64.yml") ? arm64Manifest : x64Manifest),
      writeFile: () => {},
      log: () => {},
    },
  );
  assert.deepEqual(calls, []);
  assert.equal(result.merged.version, "3.6.0");
});

test("defaults to the two per-architecture manifests and latest-mac.yml", () => {
  const options = parseArgs(["--release", "v3.6.0"]);
  assert.deepEqual(options.inputs, ["latest-mac-arm64.yml", "latest-mac-x64.yml"]);
  assert.equal(options.output, "latest-mac.yml");
  assert.throws(() => parseArgs([]), /--release/);
});
