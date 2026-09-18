import type { CallAction } from "./fast-jev-core.ts";

export interface TurnEndEvaluationPolicy {
  triggerPercent: number;
  midPercent: number;
  urgentPercent: number;
  lowPressureResultTokens: number;
  midPressureResultTokens: number;
  urgentResultTokens: number;
}

export function acceptsReduction(ratio: number, minimum: number): boolean {
  return Number.isFinite(ratio) && Number.isFinite(minimum) && ratio >= minimum;
}

/**
 * While Pi is still inside one autonomous agent run, preserve the tool-call
 * breadcrumb even when Jev says the call itself can go. Only the result
 * contents are pruned. Full drop_call is deferred until agent_end.
 */
export function activeRunAction(action: CallAction): CallAction {
  return action === "drop_call" ? "drop_result" : action;
}

export function requiredNewResultTokens(
  effectivePercent: number | null,
  policy: TurnEndEvaluationPolicy,
): number | null {
  if (
    effectivePercent === null ||
    !Number.isFinite(effectivePercent) ||
    effectivePercent < policy.triggerPercent
  ) {
    return null;
  }
  if (effectivePercent >= policy.urgentPercent) return policy.urgentResultTokens;
  if (effectivePercent >= policy.midPercent) return policy.midPressureResultTokens;
  return policy.lowPressureResultTokens;
}

/**
 * The first pass runs as soon as the trigger is crossed. Later passes are
 * driven by NEW eligible tool-result volume, with progressively lower
 * thresholds as native compaction gets closer.
 */
export function shouldEvaluateAtTurnEnd(args: {
  effectivePercent: number | null;
  forceRefresh: boolean;
  eligibleCalls: number;
  previouslyEvaluatedCalls: number;
  newEligibleCalls: number;
  newEligibleResultTokens: number;
  policy: TurnEndEvaluationPolicy;
}): boolean {
  const {
    effectivePercent,
    forceRefresh,
    eligibleCalls,
    previouslyEvaluatedCalls,
    newEligibleCalls,
    newEligibleResultTokens,
    policy,
  } = args;

  if (eligibleCalls <= 0) return false;
  if (forceRefresh) return true;

  const required = requiredNewResultTokens(effectivePercent, policy);
  if (required === null) return false;

  // First pressure-triggered evaluation in this logical-history segment.
  if (previouslyEvaluatedCalls <= 0) return true;

  if (newEligibleCalls <= 0) return false;
  return newEligibleResultTokens >= required;
}

export function canGuardNativeThreshold(args: {
  enabled: boolean;
  hasKey: boolean;
  remoteHealthy: boolean;
  committedDecisions: number;
}): boolean {
  const { enabled, hasKey, remoteHealthy, committedDecisions } = args;
  if (!enabled || !hasKey) return false;

  // A failed refresh must not invalidate already-committed logical pruning.
  // Once we have a logical history to apply, remote timeout/backoff/breaker
  // state is irrelevant to whether that history is safe to keep using.
  return committedDecisions > 0 || remoteHealthy;
}

/**
 * Pi may request its built-in threshold compaction earlier than Jev. Delay that
 * request until our later native-fallback boundary whenever the extension can
 * still provide a valid logical history. Remote Jev availability matters only
 * before any logical decisions have been committed.
 */
export function shouldDelayNativeThreshold(
  logicalPercent: number | null,
  fallbackPercent: number,
  logicalGuardAvailable: boolean,
): boolean {
  return logicalGuardAvailable &&
    logicalPercent !== null &&
    Number.isFinite(logicalPercent) &&
    logicalPercent < fallbackPercent;
}
