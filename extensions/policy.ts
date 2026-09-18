import type { CallAction } from "./fast-jev-core.ts";

export function acceptsReduction(ratio: number, minimum: number): boolean {
  return Number.isFinite(ratio) && Number.isFinite(minimum) && ratio >= minimum;
}

/**
 * While Pi is still inside one autonomous agent run, preserve the tool-call
 * breadcrumb even when Jev says the call itself can go. Only the bulky result
 * is pruned. Full drop_call is deferred until agent_end.
 */
export function activeRunAction(action: CallAction): CallAction {
  return action === "drop_call" ? "drop_result" : action;
}

export function shouldEvaluateAtTurnEnd(
  effectivePercent: number | null,
  triggerPercent: number,
  forceRefresh: boolean,
  hasEligibleCall: boolean,
): boolean {
  if (!hasEligibleCall) return false;
  if (forceRefresh) return true;
  return effectivePercent !== null &&
    Number.isFinite(effectivePercent) &&
    effectivePercent >= triggerPercent;
}

/**
 * Pi may request its built-in threshold compaction earlier than Jev. Delay that
 * request until our later native-fallback boundary, but only while Jev is
 * available. A broken/missing Jev must never disable Pi's safety net.
 */
export function shouldDelayNativeThreshold(
  logicalPercent: number | null,
  fallbackPercent: number,
  jevHealthy: boolean,
): boolean {
  return jevHealthy &&
    logicalPercent !== null &&
    Number.isFinite(logicalPercent) &&
    logicalPercent < fallbackPercent;
}
