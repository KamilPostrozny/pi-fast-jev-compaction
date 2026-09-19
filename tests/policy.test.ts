import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  contextCeiling,
  realContextBoundary,
  reconcilePressureEpisode,
  shouldCancelNativeThreshold,
  shouldEvaluateAtTurnEnd,
} from "../extensions/policy.ts";

test("active agent runs never delete the tool-call breadcrumb", () => {
  assert.equal(activeRunAction("keep"), "keep");
  assert.equal(activeRunAction("drop_result"), "drop_result");
  assert.equal(activeRunAction("drop_call"), "drop_result");
});

test("context ceiling is derived from model window and Pi reserve", () => {
  assert.equal(contextCeiling(65_536, 16_384), 49_152);
  assert.equal(contextCeiling(112_640, 16_384), 96_256);
  assert.equal(contextCeiling(262_144, 16_384), 245_760);
  assert.equal(contextCeiling(262_144, 32_768), 229_376);
});

test("same reserve naturally changes the percentage boundary as context grows", () => {
  const small = realContextBoundary({
    tokens: 49_153,
    contextWindow: 65_536,
    reserveTokens: 16_384,
  });
  const medium = realContextBoundary({
    tokens: 96_257,
    contextWindow: 112_640,
    reserveTokens: 16_384,
  });
  const large = realContextBoundary({
    tokens: 245_761,
    contextWindow: 262_144,
    reserveTokens: 16_384,
  });

  assert.equal(small?.overCeiling, true);
  assert.equal(medium?.overCeiling, true);
  assert.equal(large?.overCeiling, true);
  assert.ok((small?.percent ?? 0) < (medium?.percent ?? 0));
  assert.ok((medium?.percent ?? 0) < (large?.percent ?? 0));
});

test("real context boundary has no opinion when Pi usage is unavailable", () => {
  const boundary = realContextBoundary({
    tokens: null,
    contextWindow: 112_640,
    reserveTokens: 16_384,
  });
  assert.equal(boundary?.tokens, null);
  assert.equal(boundary?.percent, null);
  assert.equal(boundary?.overCeiling, false);
});

test("accepted Jev pass is validated by the next real post-turn usage", () => {
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usageRefreshed: false,
      overCeiling: true,
    }),
    "awaiting_validation",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usageRefreshed: true,
      overCeiling: false,
    }),
    "armed",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usageRefreshed: true,
      overCeiling: true,
    }),
    "exhausted",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usageRefreshed: true,
      overCeiling: null,
    }),
    "exhausted",
  );
});

test("exhausted pressure episode only re-arms after real usage returns below ceiling", () => {
  assert.equal(
    reconcilePressureEpisode({
      state: "exhausted",
      usageRefreshed: false,
      overCeiling: true,
    }),
    "exhausted",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "exhausted",
      usageRefreshed: false,
      overCeiling: false,
    }),
    "armed",
  );
});

test("automatic Jev evaluation runs once per above-ceiling pressure episode", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      pressureEpisode: "armed",
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 1,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      pressureEpisode: "awaiting_validation",
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 1,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      pressureEpisode: "exhausted",
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 10,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: false,
      pressureEpisode: "armed",
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 10,
    }),
    false,
  );
});

test("manual refresh bypasses pressure episode state but still needs an eligible call", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      pressureEpisode: "exhausted",
      forceRefresh: true,
      eligibleCalls: 1,
      newEligibleCalls: 0,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      pressureEpisode: "exhausted",
      forceRefresh: true,
      eligibleCalls: 0,
      newEligibleCalls: 0,
    }),
    false,
  );
});

test("any actual pruning is accepted but must still pass pressure validation", () => {
  assert.equal(acceptsReduction(0), false);
  assert.equal(acceptsReduction(1), true);
  assert.equal(acceptsReduction(20), true);
});

test("native threshold is cancelled only while the one Jev attempt awaits validation", () => {
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "awaiting_validation",
      usageTokens: 100_000,
      ceilingTokens: 96_256,
    }),
    true,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "exhausted",
      usageTokens: 100_000,
      ceilingTokens: 96_256,
    }),
    false,
  );
});

test("outside validation window native decision trusts real Pi usage only", () => {
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "armed",
      usageTokens: 96_000,
      ceilingTokens: 96_256,
    }),
    true,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "exhausted",
      usageTokens: 96_000,
      ceilingTokens: 96_256,
    }),
    true,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "armed",
      usageTokens: 96_257,
      ceilingTokens: 96_256,
    }),
    false,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: "armed",
      usageTokens: null,
      ceilingTokens: 96_256,
    }),
    false,
  );
});
