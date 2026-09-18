import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  shouldDelayNativeThreshold,
  shouldEvaluateAtTurnEnd,
} from "../extensions/policy.ts";

test("insufficient Jev reductions are rejected instead of committed", () => {
  assert.equal(acceptsReduction(0.24, 0.25), false);
  assert.equal(acceptsReduction(0.25, 0.25), true);
  assert.equal(acceptsReduction(0.80, 0.25), true);
});

test("active agent runs never delete the tool-call breadcrumb", () => {
  assert.equal(activeRunAction("keep"), "keep");
  assert.equal(activeRunAction("drop_result"), "drop_result");
  assert.equal(activeRunAction("drop_call"), "drop_result");
});

test("Jev evaluates at turn_end only when armed or forced", () => {
  assert.equal(shouldEvaluateAtTurnEnd(79.9, 80, false, true), false);
  assert.equal(shouldEvaluateAtTurnEnd(80, 80, false, true), true);
  assert.equal(shouldEvaluateAtTurnEnd(40, 80, true, true), true);
  assert.equal(shouldEvaluateAtTurnEnd(90, 80, false, false), false);
});

test("native threshold is delayed to the fallback boundary only while Jev is healthy", () => {
  assert.equal(shouldDelayNativeThreshold(87.4, 87.5, true), true);
  assert.equal(shouldDelayNativeThreshold(87.5, 87.5, true), false);
  assert.equal(shouldDelayNativeThreshold(76, 87.5, false), false);
  assert.equal(shouldDelayNativeThreshold(null, 87.5, true), false);
});
