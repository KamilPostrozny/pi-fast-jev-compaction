import type { CallAction } from "./fast-jev-core.ts";

export interface TurnEndEvaluationPolicy {
  triggerPercent: number;
  midPercent: number;
  urgentPercent: number;
  lowPressureResultPercent: number;
  midPressureResultPercent: number;
  urgentResultPercent: number;
}

export interface CalibratedPressureInput {
  logicalTokens: number;
  contextWindow: number | null | undefined;
  providerTokens?: number | null;
  providerPercent?: number | null;
  pendingReductionTokens?: number;
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

/**
 * One conservative pressure signal used everywhere in the adapter.
 *
 * Pi's last provider usage can lag behind a freshly-pruned logical context, so
 * subtract only reductions committed after that measurement. The local logical
 * estimate catches growth that Pi's provider-backed number has not reflected
 * yet. Taking the larger of the two prevents the scheduler and native fallback
 * from disagreeing about how full the context is.
 */
export function calibratedPressurePercent(input: CalibratedPressureInput): number | null {
  const contextWindow = input.contextWindow;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    const providerPercent = input.providerPercent;
    return providerPercent !== null &&
      providerPercent !== undefined &&
      Number.isFinite(providerPercent)
      ? providerPercent
      : null;
  }

  const estimatedPercent =
    Number.isFinite(input.logicalTokens) && input.logicalTokens >= 0
      ? (input.logicalTokens / contextWindow) * 100
      : null;

  let providerAdjustedPercent: number | null = null;
  if (
    input.providerTokens !== null &&
    input.providerTokens !== undefined &&
    Number.isFinite(input.providerTokens)
  ) {
    const pending = Math.max(0, input.pendingReductionTokens ?? 0);
    providerAdjustedPercent =
      (Math.max(0, input.providerTokens - pending) / contextWindow) * 100;
  } else if (
    input.providerPercent !== null &&
    input.providerPercent !== undefined &&
    Number.isFinite(input.providerPercent)
  ) {
    providerAdjustedPercent = input.providerPercent;
  }

  if (estimatedPercent === null) return providerAdjustedPercent;
  if (providerAdjustedPercent === null) return estimatedPercent;
  return Math.max(estimatedPercent, providerAdjustedPercent);
}

function resultPercentForPressure(
  pressurePercent: number,
  policy: TurnEndEvaluationPolicy,
): number {
  if (pressurePercent >= policy.urgentPercent) return policy.urgentResultPercent;
  if (pressurePercent >= policy.midPercent) return policy.midPressureResultPercent;
  return policy.lowPressureResultPercent;
}

export function requiredNewResultTokens(
  pressurePercent: number | null,
  contextWindow: number | null | undefined,
  policy: TurnEndEvaluationPolicy,
): number | null {
  if (
    pressurePercent === null ||
    !Number.isFinite(pressurePercent) ||
    pressurePercent < policy.triggerPercent ||
    !contextWindow ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null;
  }

  const fraction = Math.max(0, resultPercentForPressure(pressurePercent, policy)) / 100;
  // "0%" means any non-empty new eligible result is enough.
  return Math.max(1, Math.ceil(contextWindow * fraction));
}

/**
 * The first pass runs as soon as the trigger is crossed. Later passes are
 * driven by NEW eligible tool-result volume. The volume gates are percentages
 * of the current model's context window, so a 32k, 64k, or 128k model gets the
 * same policy rather than the same absolute token count.
 */
export function shouldEvaluateAtTurnEnd(args: {
  pressurePercent: number | null;
  contextWindow: number | null | undefined;
  forceRefresh: boolean;
  eligibleCalls: number;
  previouslyEvaluatedCalls: number;
  newEligibleCalls: number;
  newEligibleResultTokens: number;
  policy: TurnEndEvaluationPolicy;
}): boolean {
  const {
    pressurePercent,
    contextWindow,
    forceRefresh,
    eligibleCalls,
    previouslyEvaluatedCalls,
    newEligibleCalls,
    newEligibleResultTokens,
    policy,
  } = args;

  if (eligibleCalls <= 0) return false;
  if (forceRefresh) return true;

  const required = requiredNewResultTokens(pressurePercent, contextWindow, policy);
  if (required === null) return false;

  // First pressure-triggered evaluation in this logical-history segment.
  if (previouslyEvaluatedCalls <= 0) return true;

  if (newEligibleCalls <= 0) return false;
  return newEligibleResultTokens >= required;
}

/**
 * Pi may request its built-in threshold compaction earlier than Jev. Delay that
 * request until our later native-fallback boundary, but only while Jev is
 * available. A broken/missing Jev must never disable Pi's safety net.
 */
export function shouldDelayNativeThreshold(
  pressurePercent: number | null,
  fallbackPercent: number,
  jevHealthy: boolean,
): boolean {
  return jevHealthy &&
    pressurePercent !== null &&
    Number.isFinite(pressurePercent) &&
    pressurePercent < fallbackPercent;
}
