import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_VERSION, nextVersion } from "../scripts/next-version.mjs";

test("starts from the fallback when nothing has been published", () => {
  assert.equal(nextVersion({}), FALLBACK_VERSION);
  assert.equal(nextVersion({ published: [], upstream: null }), FALLBACK_VERSION);
});

test("bumps the fork's own latest release", () => {
  assert.equal(nextVersion({ published: ["3.6.0"], upstream: "3.5.3" }), "3.6.1");
  assert.equal(nextVersion({ published: ["3.6.0", "3.6.1"] }), "3.6.2");
});

test("never falls below an upstream release the fork has not caught up with", () => {
  assert.equal(nextVersion({ published: ["3.6.5"], upstream: "3.7.0" }), "3.7.1");
  assert.equal(nextVersion({ published: ["3.6.0"], upstream: "4.0.0" }), "4.0.1");
});

test("takes the first release above upstream when the fork is empty", () => {
  assert.equal(nextVersion({ published: [], upstream: "3.5.3" }), "3.5.4");
});

test("ignores tags that are not stable versions", () => {
  assert.equal(nextVersion({ published: ["v3.6.0-rc1", "3.6.0", "engine-1.18.32-r3"] }), "3.6.1");
});
