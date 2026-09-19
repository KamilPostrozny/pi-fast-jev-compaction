import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  contextCeiling,
  PRESSURE_REARM_PERCENT,
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

test("pressure hysteresis has one explicit context-size-independent re-arm boundary", () => {
  assert.equal(PRESSURE_REARM_PERCENT, 70);
});

test("accepted Jev pass only re-arms after validation reaches hysteresis boundary", () => {
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usagePercent: 69.9,
    }),
    "armed",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usagePercent: 70,
    }),
    "armed",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usagePercent: 70.01,
    }),
    "exhausted",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "awaiting_validation",
      usagePercent: null,
    }),
    "exhausted",
  );
});

test("exhausted pressure episode stays disarmed until usage reaches hysteresis boundary", () => {
  assert.equal(
    reconcilePressureEpisode({
      state: "exhausted",
      usagePercent: 85,
    }),
    "exhausted",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "exhausted",
      usagePercent: 74,
    }),
    "exhausted",
  );
  assert.equal(
    reconcilePressureEpisode({
      state: "exhausted",
      usagePercent: 70,
    }),
    "armed",
  );
});

test("automatic Jev evaluation runs once per armed above-ceiling pressure episode", () => {
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
});

test("110k failed reclaim exhausts the episode instead of micro-pruning again", () => {
  const ceiling = 96_256;
  const after = 100_987;
  const window = 112_640;
  const usagePercent = (after / window) * 100;

  const episode = reconcilePressureEpisode({
    state: "awaiting_validation",
    usagePercent,
  });
  assert.equal(episode, "exhausted");

  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: after > ceiling,
      pressureEpisode: episode,
      forceRefresh: false,
      eligibleCalls: 76,
      newEligibleCalls: 1,
    }),
    false,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      pressureEpisode: episode,
      usageTokens: after,
      ceilingTokens: ceiling,
    }),
    false,
  );
});

test("latest 110k 80 percent edge reclaim stays disarmed even though below Pi ceiling", () => {
  const after = 90_115;
  const window = 112_640;
  const ceiling = 96_256;
  assert.ok(after < ceiling);
  assert.equal(Number(((after / window) * 100).toFixed(2)), 80);

  const episode = reconcilePressureEpisode({
    state: "awaiting_validation",
    usagePercent: (after / window) * 100,
  });
  assert.equal(episode, "exhausted");
});

test("64k large reclaim still re-arms", () => {
  const after = 34_285;
  const window = 65_536;

  const episode = reconcilePressureEpisode({
    state: "awaiting_validation",
    usagePercent: (after / window) * 100,
  });
  assert.equal(episode, "armed");
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

test("any actual pruning is accepted; hysteresis controls re-arm instead", () => {
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
