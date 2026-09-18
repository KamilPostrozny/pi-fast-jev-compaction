import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsReduction,
  activeRunAction,
  requiredNewResultTokens,
  shouldDelayNativeThreshold,
  shouldEvaluateAtTurnEnd,
  type TurnEndEvaluationPolicy,
} from "../extensions/policy.ts";

const policy: TurnEndEvaluationPolicy = {
  triggerPercent: 75,
  midPercent: 80,
  urgentPercent: 84,
  lowPressureResultTokens: 2000,
  midPressureResultTokens: 1000,
  urgentResultTokens: 1,
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

test("adaptive result-volume thresholds tighten near native fallback", () => {
  assert.equal(requiredNewResultTokens(74.9, policy), null);
  assert.equal(requiredNewResultTokens(75, policy), 2000);
  assert.equal(requiredNewResultTokens(79.9, policy), 2000);
  assert.equal(requiredNewResultTokens(80, policy), 1000);
  assert.equal(requiredNewResultTokens(83.9, policy), 1000);
  assert.equal(requiredNewResultTokens(84, policy), 1);
  assert.equal(requiredNewResultTokens(87.4, policy), 1);
});

test("first Jev pass runs at 75% regardless of accumulated result volume", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      effectivePercent: 75,
      forceRefresh: false,
      eligibleCalls: 10,
      previouslyEvaluatedCalls: 0,
      newEligibleCalls: 10,
      newEligibleResultTokens: 200,
      policy,
    }),
    true,
  );
});

test("later Jev passes wait for enough new result volume", () => {
  assert.equal(
    shouldEvaluateAtTurnEnd({
      effectivePercent: 78,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 2,
      newEligibleResultTokens: 1999,
      policy,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      effectivePercent: 78,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 2,
      newEligibleResultTokens: 2000,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      effectivePercent: 82,
      forceRefresh: false,
      eligibleCalls: 20,
      previouslyEvaluatedCalls: 10,
      newEligibleCalls: 1,
      newEligibleResultTokens: 1000,
      policy,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateAtTurnEnd({
      effectivePercent: 84,
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
      effectivePercent: 86,
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
      effectivePercent: 20,
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
      effectivePercent: 90,
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

test("native threshold is delayed to the fallback boundary only while Jev is healthy", () => {
  assert.equal(shouldDelayNativeThreshold(87.4, 87.5, true), true);
  assert.equal(shouldDelayNativeThreshold(87.5, 87.5, true), false);
  assert.equal(shouldDelayNativeThreshold(76, 87.5, false), false);
  assert.equal(shouldDelayNativeThreshold(null, 87.5, true), false);
});
