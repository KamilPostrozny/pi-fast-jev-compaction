import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  pruningAcceptance,
  activeRunAction,
  contextCeiling,
  hasFreshAssistantUsage,
  realContextBoundary,
  reconcilePressureEpisode,
  shouldCancelNativeThreshold,
  shouldEvaluateAtTurnEnd,
  type PressureEpisodeState,
} from "../extensions/policy.ts";

function boundary(tokens: number | null, contextWindow = 112_640, reserveTokens = 16_384) {
  return realContextBoundary({ tokens, contextWindow, reserveTokens })!;
}

function reconcile(tokens: number | null, state: PressureEpisodeState = "awaiting_validation") {
  return reconcilePressureEpisode({ state, boundary: boundary(tokens) });
}

test("active agent runs never delete the tool-call breadcrumb", () => {
  assert.equal(activeRunAction("keep"), "keep");
  assert.equal(activeRunAction("drop_result"), "drop_result");
  assert.equal(activeRunAction("drop_call"), "drop_result");
});

test("ceiling and re-arm scale with window and resolved Pi reserve", () => {
  for (const [window, reserve, ceiling, rearm] of [
    [32_768, 16_384, 16_384, 14_745],
    [65_536, 16_384, 49_152, 45_875],
    [112_640, 16_384, 96_256, 90_624],
    [262_144, 16_384, 245_760, 237_568],
    [262_144, 32_768, 229_376, 216_268],
    [112_640, 8_192, 104_448, 100_352],
  ]) {
    const b = boundary(ceiling + 1, window, reserve);
    assert.equal(contextCeiling(window, reserve), ceiling);
    assert.equal(b.ceilingTokens, ceiling);
    assert.equal(b.rearmTokens, rearm);
    assert.equal(b.hysteresisMarginTokens, ceiling - rearm);
    assert.equal(b.overCeiling, true);
    assert.ok(b.rearmTokens < b.ceilingTokens);
  }
});

test("accepted pruning re-arms at the exact token boundary, not rounded percent", () => {
  assert.equal(reconcile(90_623), "armed");
  assert.equal(reconcile(90_624), "armed");
  assert.equal(reconcile(90_625), "exhausted");
  assert.equal(reconcile(95_000), "exhausted");
  assert.equal(reconcile(96_256), "exhausted");
  assert.equal(reconcile(100_987), "exhausted");
});

test("exhausted episode waits for re-arm headroom; armed state stays armed", () => {
  assert.equal(reconcile(95_000, "exhausted"), "exhausted");
  assert.equal(reconcile(90_624, "exhausted"), "armed");
  assert.equal(reconcile(95_000, "armed"), "armed");
});

test("observed useful 110k reclaims now re-arm, including the 80 percent trace", () => {
  for (const tokens of [88_248, 89_790, 88_684, 81_531, 79_482, 81_385, 83_915, 90_115]) {
    assert.equal(reconcile(tokens), "armed");
  }
  assert.equal(reconcilePressureEpisode({
    state: "awaiting_validation", boundary: boundary(34_285, 65_536),
  }), "armed");
});

test("32k and large-reserve models never re-arm above their native ceiling", () => {
  for (const b of [boundary(20_000, 32_768), boundary(70_000, 112_640, 50_000)]) {
    assert.ok(b.percent! < 70); // The old percentage-only policy re-armed here.
    assert.equal(b.overCeiling, true);
    const state = reconcilePressureEpisode({ state: "awaiting_validation", boundary: b });
    assert.equal(state, "exhausted");
    assert.equal(shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true, overCeiling: b.overCeiling,
      pressureEpisode: state, forceRefresh: false, eligibleCalls: 10, newEligibleCalls: 1,
    }), false);
  }
});

test("zero reserve requires strictly below ceiling; zero ceiling cannot re-arm", () => {
  const zeroReserve = boundary(112_640, 112_640, 0);
  assert.equal(zeroReserve.rearmTokens, zeroReserve.ceilingTokens);
  assert.equal(reconcilePressureEpisode({ state: "exhausted", boundary: zeroReserve }), "exhausted");
  assert.equal(reconcilePressureEpisode({ state: "exhausted", boundary: boundary(112_639, 112_640, 0) }), "armed");
  for (const reserve of [112_640, 200_000]) {
    const b = boundary(0, 112_640, reserve);
    assert.equal(b.rearmTokens, 0);
    assert.equal(b.ceilingTokens, 0);
    assert.equal(reconcilePressureEpisode({ state: "awaiting_validation", boundary: b }), "exhausted");
  }
});

test("missing/invalid usage cannot validate or re-arm an episode", () => {
  for (const tokens of [null, NaN, Infinity]) {
    const b = boundary(tokens);
    assert.equal(b.tokens, null);
    assert.equal(b.percent, null);
    assert.equal(b.overCeiling, false);
    assert.equal(reconcilePressureEpisode({ state: "awaiting_validation", boundary: b }), "exhausted");
    assert.equal(reconcilePressureEpisode({ state: "exhausted", boundary: b }), "exhausted");
  }
  assert.equal(reconcilePressureEpisode({ state: "awaiting_validation", boundary: null }), "exhausted");
  for (const contextWindow of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(realContextBoundary({ tokens: 1, contextWindow, reserveTokens: 16_384 }), null);
  }
});

test("invalid reserves retain existing zero-reserve normalization", () => {
  for (const reserve of [-1, NaN, Infinity]) {
    const b = boundary(100, 1000, reserve);
    assert.equal(b.reserveTokens, 0);
    assert.equal(b.ceilingTokens, 1000);
    assert.equal(b.rearmTokens, 1000);
  }
});

test("fresh usage requires a successful current assistant response with positive usage", () => {
  for (const stopReason of ["stop", "toolUse", "length"]) {
    assert.equal(hasFreshAssistantUsage({ role: "assistant", stopReason, usage: { totalTokens: 100 } }), true);
    assert.equal(hasFreshAssistantUsage({ role: "assistant", stopReason, usage: { cacheRead: 90, output: 10 } }), true);
  }
  for (const stopReason of ["error", "aborted", "pending", "deferred", undefined]) {
    assert.equal(hasFreshAssistantUsage({ role: "assistant", stopReason, usage: { totalTokens: 100 } }), false);
  }
  for (const usage of [undefined, {}, { totalTokens: 0 }, { totalTokens: Infinity }, { totalTokens: -1 }]) {
    assert.equal(hasFreshAssistantUsage({ role: "assistant", stopReason: "stop", usage }), false);
  }
  assert.equal(hasFreshAssistantUsage({ role: "user", stopReason: "stop", usage: { totalTokens: 100 } }), false);
});

test("automatic Jev requires enabled compaction, pressure, armed state and new eligible calls", () => {
  const args = {
    autoCompactionEnabled: true, overCeiling: true,
    pressureEpisode: "armed" as PressureEpisodeState,
    forceRefresh: false, eligibleCalls: 10, newEligibleCalls: 1,
  };
  assert.equal(shouldEvaluateAtTurnEnd(args), true);
  for (const override of [
    { autoCompactionEnabled: false }, { overCeiling: false },
    { pressureEpisode: "awaiting_validation" as const },
    { pressureEpisode: "exhausted" as const }, { eligibleCalls: 0 }, { newEligibleCalls: 0 },
  ]) assert.equal(shouldEvaluateAtTurnEnd({ ...args, ...override }), false);
  assert.equal(shouldEvaluateAtTurnEnd({
    ...args, autoCompactionEnabled: false, overCeiling: false,
    pressureEpisode: "exhausted", newEligibleCalls: 0, forceRefresh: true,
  }), true);
  assert.equal(shouldEvaluateAtTurnEnd({ ...args, forceRefresh: true, eligibleCalls: 0 }), false);
});

test("actual pruning is necessary; manual refresh has no percentage reduction floor", () => {
  for (const value of [0, -1, NaN, Infinity]) assert.equal(acceptsReduction(value), false);
  assert.equal(acceptsReduction(1), true);
  assert.equal(acceptsReduction(20), true);
});

test("automatic savings floor equals the resolved hysteresis gap, not a reduction percentage", () => {
  const args = { changedResults: 1, estimatedSavedTokens: 5_632, automatic: true, boundary: boundary(97_000) };
  assert.deepEqual(pruningAcceptance(args), {
    accepted: true, reason: "worthwhile_estimated_savings", minimumSavedTokens: 5_632,
  });
  for (const estimatedSavedTokens of [0, 868, 1_994, 5_631, NaN, Infinity]) {
    assert.equal(pruningAcceptance({ ...args, estimatedSavedTokens }).accepted, false);
  }
  assert.equal(pruningAcceptance({ ...args, changedResults: 0 }).accepted, false);
  assert.equal(pruningAcceptance({ ...args, boundary: null }).accepted, false);
  assert.equal(pruningAcceptance({ ...args, boundary: boundary(250_000, 262_144) }).accepted, false);
  assert.equal(pruningAcceptance({ ...args, boundary: boundary(50_000, 65_536) }).accepted, true);
  assert.equal(pruningAcceptance({ ...args, estimatedSavedTokens: 1, boundary: boundary(112_641, 112_640, 0) }).accepted, true);
  assert.deepEqual(pruningAcceptance({ ...args, estimatedSavedTokens: 1, automatic: false, boundary: null }), {
    accepted: true, reason: "manual_override", minimumSavedTokens: 0,
  });
});

test("native threshold cancellation ends after failed validation", () => {
  assert.equal(shouldCancelNativeThreshold({
    pressureEpisode: "awaiting_validation", usageTokens: 100_987, ceilingTokens: 96_256,
  }), true);
  assert.equal(shouldCancelNativeThreshold({
    pressureEpisode: reconcile(100_987), usageTokens: 100_987, ceilingTokens: 96_256,
  }), false);
  for (const pressureEpisode of ["armed", "exhausted"] as const) {
    for (const [usageTokens, expected] of [[96_256, true], [96_257, false], [null, false]] as const) {
      assert.equal(shouldCancelNativeThreshold({ pressureEpisode, usageTokens, ceilingTokens: 96_256 }), expected);
    }
  }
});
