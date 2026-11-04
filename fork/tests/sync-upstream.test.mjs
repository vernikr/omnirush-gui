import assert from "node:assert/strict";
import { test } from "node:test";
import { upstreamFetchSpec } from "../scripts/sync-upstream.mjs";

test("fetches branches into their upstream remote-tracking ref", () => {
  assert.deepEqual(upstreamFetchSpec("main"), {
    sourceRef: "refs/heads/main",
    trackingRef: "refs/remotes/upstream/main",
  });
});

test("fetches version tags without overwriting same-named fork tags", () => {
  assert.deepEqual(upstreamFetchSpec("v3.7.0"), {
    sourceRef: "refs/tags/v3.7.0",
    trackingRef: "refs/remotes/upstream/tags/v3.7.0",
  });
});

test("accepts fully qualified upstream refs", () => {
  assert.deepEqual(upstreamFetchSpec("refs/tags/box-2026.10.2"), {
    sourceRef: "refs/tags/box-2026.10.2",
    trackingRef: "refs/remotes/upstream/tags/box-2026.10.2",
  });
});
