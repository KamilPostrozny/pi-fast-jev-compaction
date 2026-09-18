import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  hasNativeHeadroom,
  shouldRefreshSettledEligible,
} from "../extensions/policy.ts";

test("insufficient Jev reductions are rejected instead of committed", () => {
  assert.equal(acceptsReduction(0.24, 0.25), false);
  assert.equal(acceptsReduction(0.25, 0.25), true);
  assert.equal(acceptsReduction(0.80, 0.25), true);
});

test("new eligible calls refresh at most once per settled generation", () => {
  assert.equal(shouldRefreshSettledEligible(true, 3, 2, true), true);
  assert.equal(shouldRefreshSettledEligible(true, 3, 3, true), false);
  assert.equal(shouldRefreshSettledEligible(true, 3, 2, false), false);
  assert.equal(shouldRefreshSettledEligible(false, 3, 2, true), false);
});

test("native compaction is cancelled only when logical context fits Pi's native limit", () => {
  assert.equal(hasNativeHeadroom(80_000, 100_000, 20_000), true);
  assert.equal(hasNativeHeadroom(80_001, 100_000, 20_000), false);
  assert.equal(hasNativeHeadroom(10_000, undefined, 20_000), false);
});
