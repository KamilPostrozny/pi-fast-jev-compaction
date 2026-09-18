import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  calibratedPressurePercent,
  requiredNewResultTokens,
  shouldDelayNativeThreshold,
  shouldEvaluateAtTurnEnd,
  type TurnEndEvaluationPolicy,
} from "../extensions/policy.ts";

const policy: TurnEndEvaluationPolicy = {
  triggerPercent: 75,
  midPercent: 80,
  urgentPercent: 84,
  lowPressureResultPercent: 3,
  midPressureResultPercent: 1.5,
  urgentResultPercent: 0,
};

test("small but useful Jev reductions are accepted", () => {
  assert.equal(acceptsReduction(0.009, 0.01), false);
  assert.equal(acceptsReduction(0.01, 0.01), true);
  assert.equal(acceptsReduction(0.05, 0.01), true);
});

test("active agent runs never delete the tool-call breadcrumb", () => {
  assert.equal(activeRunAction("keep"), "keep");
  assert.equal(activeRunAction("drop_result"), "drop_result");
  assert.equal(activeRunAction("drop_call"), "drop_result");
});

test("calibrated pressure uses the more conservative logical/provider signal", () => {
  assert.equal(
    calibratedPressurePercent({
      logicalTokens: 58_982,
      contextWindow: 65_536,
      providerPercent: 80.5,
    })?.toFixed(2),
    ((58_982 / 65_536) * 100).toFixed(2),
  );

  assert.equal(
    calibratedPressurePercent({
      logicalTokens: 40_000,
      contextWindow: 65_536,
      providerTokens: 52_000,
      pendingReductionTokens: 5_000,
    })?.toFixed(2),
    ((47_000 / 65_536) * 100).toFixed(2),
  );
});

test("result-volume gates scale with context window instead of fixed token counts", () => {
  for (const window of [32_768, 65_536, 131_072]) {
    assert.equal(
      requiredNewResultTokens(75, window, policy),
      Math.ceil(window * 0.03),
    );
    assert.equal(
      requiredNewResultTokens(82, window, policy),
      Math.ceil(window * 0.015),
    );
    assert.equal(requiredNewResultTokens(84, window, policy), 1);
  }

  assert.equal(requiredNewResultTokens(74.9, 65_536, policy), null);
  assert.equal(requiredNewResultTokens(80, undefined, policy), null);
});

test("first Jev pass runs at 75% regardless of accumulated result volume", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 75,
      contextWindow: 65_536,
      forceRefresh: false,
      eligibleCalls: 10,
      previouslyEvaluatedCalls: 0,
      newEligibleCalls: 10,
      newEligibleResultTokens: 1,
      policy,
    }),
    true,
  );
});

test("later Jev passes use context-relative new-result volume", () => {
  const window = 65_536;
  const lowRequired = Math.ceil(window * 0.03);
  const midRequired = Math.ceil(window * 0.015);

  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 78,
      contextWindow: window,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 2,
      newEligibleResultTokens: lowRequired - 1,
      policy,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 78,
      contextWindow: window,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 2,
      newEligibleResultTokens: lowRequired,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 82,
      contextWindow: window,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 1,
      newEligibleResultTokens: midRequired,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 84,
      contextWindow: window,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 1,
      newEligibleResultTokens: 1,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 86,
      contextWindow: window,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 0,
      newEligibleResultTokens: 0,
      policy,
    }),
    false,
  );
});

test("forced refresh bypasses pressure and volume gates but still needs eligible calls", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 20,
      contextWindow: 65_536,
      forceRefresh: true,
      eligibleCalls: 1,
      previouslyEvaluatedCalls: 100,
      newEligibleCalls: 0,
      newEligibleResultTokens: 0,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      pressurePercent: 90,
      contextWindow: 65_536,
      forceRefresh: true,
      eligibleCalls: 0,
      previouslyEvaluatedCalls: 0,
      newEligibleCalls: 0,
      newEligibleResultTokens: 0,
      policy,
    }),
    false,
  );
});

test("native threshold uses the same calibrated pressure boundary", () => {
  assert.equal(shouldDelayNativeThreshold(87.4, 87.5, true), true);
  assert.equal(shouldDelayNativeThreshold(87.5, 87.5, true), false);
  assert.equal(shouldDelayNativeThreshold(76, 87.5, false), false);
  assert.equal(shouldDelayNativeThreshold(null, 87.5, true), false);
});
