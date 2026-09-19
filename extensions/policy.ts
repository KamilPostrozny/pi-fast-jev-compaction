import type { CallAction } from "./fast-jev-core.ts";

export interface RealContextBoundary {
  tokens: number | null;
  contextWindow: number;
  reserveTokens: number;
  ceilingTokens: number;
  percent: number | null;
  overCeiling: boolean;
}

export function contextCeiling(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = Number.isFinite(reserveTokens) ? Math.max(0, reserveTokens) : 0;
  return Math.max(0, contextWindow - reserve);
}

export function realContextBoundary(args: {
  tokens: number | null | undefined;
  contextWindow: number | null | undefined;
  reserveTokens: number;
}): RealContextBoundary | null {
  const { tokens, contextWindow, reserveTokens } = args;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  const ceilingTokens = contextCeiling(contextWindow, reserveTokens);
  const realTokens =
    tokens !== null && tokens !== undefined && Number.isFinite(tokens)
      ? Math.max(0, tokens)
      : null;

  return {
    tokens: realTokens,
    contextWindow,
    reserveTokens: Math.max(0, Number.isFinite(reserveTokens) ? reserveTokens : 0),
    ceilingTokens,
    percent: realTokens === null ? null : (realTokens / contextWindow) * 100,
    overCeiling: realTokens !== null && realTokens > ceilingTokens,
  };
}

export function acceptsReduction(changedResults: number): boolean {
  return Number.isFinite(changedResults) && changedResults > 0;
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
 * Auto-evaluate only when Pi's own real context usage is past its configured
 * safe-input ceiling and there is genuinely new eligible tool output to score.
 * Manual refresh bypasses the ceiling but still requires an eligible call.
 */
export function shouldEvaluateAtTurnEnd(args: {
  autoCompactionEnabled: boolean;
  overCeiling: boolean;
  forceRefresh: boolean;
  eligibleCalls: number;
  newEligibleCalls: number;
}): boolean {
  const {
    autoCompactionEnabled,
    overCeiling,
    forceRefresh,
    eligibleCalls,
    newEligibleCalls,
  } = args;

  if (eligibleCalls <= 0) return false;
  if (forceRefresh) return true;
  return autoCompactionEnabled && overCeiling && newEligibleCalls > 0;
}

/**
 * A successful Jev pass changes the next model-facing prompt, but Pi cannot
 * report the new real usage until a provider request has actually consumed it.
 * Cancel the pending threshold compaction once while waiting for that refresh.
 *
 * Outside that one stale-usage window, trust Pi's real usage directly. If Pi
 * somehow asks to compact while its current usage is already below its own
 * ceiling, cancel the redundant request; otherwise let native compaction run.
 */
export function shouldCancelNativeThreshold(args: {
  awaitingUsageRefresh: boolean;
  usageTokens: number | null;
  ceilingTokens: number | null;
}): boolean {
  const { awaitingUsageRefresh, usageTokens, ceilingTokens } = args;
  if (awaitingUsageRefresh) return true;
  return (
    usageTokens !== null &&
    ceilingTokens !== null &&
    Number.isFinite(usageTokens) &&
    Number.isFinite(ceilingTokens) &&
    usageTokens <= ceilingTokens
  );
}
