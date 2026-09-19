import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  contextCeiling,
  realContextBoundary,
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

test("automatic Jev evaluation requires Pi ceiling pressure and new eligible output", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: false,
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 10,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 0,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: true,
      overCeiling: true,
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 1,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: false,
      overCeiling: true,
      forceRefresh: false,
      eligibleCalls: 10,
      newEligibleCalls: 1,
    }),
    false,
  );
});

test("manual refresh bypasses ceiling but still needs an eligible call", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      autoCompactionEnabled: false,
      overCeiling: false,
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
      forceRefresh: true,
      eligibleCalls: 0,
      newEligibleCalls: 0,
    }),
    false,
  );
});

test("any actual pruning is accepted; there is no aggregate reduction threshold", () => {
  assert.equal(acceptsReduction(0), false);
  assert.equal(acceptsReduction(1), true);
  assert.equal(acceptsReduction(20), true);
});

test("native threshold is cancelled once while waiting for fresh provider usage", () => {
  assert.equal(
    shouldCancelNativeThreshold({
      awaitingUsageRefresh: true,
      usageTokens: 100_000,
      ceilingTokens: 96_256,
    }),
    true,
  );
});

test("outside stale-usage window native decision trusts real Pi usage only", () => {
  assert.equal(
    shouldCancelNativeThreshold({
      awaitingUsageRefresh: false,
      usageTokens: 96_000,
      ceilingTokens: 96_256,
    }),
    true,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      awaitingUsageRefresh: false,
      usageTokens: 96_257,
      ceilingTokens: 96_256,
    }),
    false,
  );
  assert.equal(
    shouldCancelNativeThreshold({
      awaitingUsageRefresh: false,
      usageTokens: null,
      ceilingTokens: 96_256,
    }),
    false,
  );
});
