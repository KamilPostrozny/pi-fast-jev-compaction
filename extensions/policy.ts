import type { CallAction } from "./fast-jev-core.ts";

export const PRESSURE_REARM_PERCENT = 70;

export type PressureEpisodeState =
  | "armed"
  | "awaiting_validation"
  | "exhausted";

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
 * Reconcile one automatic Jev pressure episode using Pi's next authoritative
 * post-turn context usage.
 *
 * - awaiting_validation + usage <= re-arm threshold => the pass created
 *   enough runway; re-arm Jev for a future ceiling crossing.
 * - awaiting_validation + usage > re-arm threshold (or usage unavailable) =>
 *   keep the pruning but exhaust this episode, preventing edge oscillation.
 * - exhausted + usage <= re-arm threshold => some compaction/reduction created
 *   enough hysteresis, so Jev may arm again.
 */
export function reconcilePressureEpisode(args: {
  state: PressureEpisodeState;
  usagePercent: number | null;
  rearmPercent?: number;
}): PressureEpisodeState {
  const { state, usagePercent, rearmPercent = PRESSURE_REARM_PERCENT } = args;
  const canRearm =
    usagePercent !== null &&
    Number.isFinite(usagePercent) &&
    usagePercent <= rearmPercent;

  // This function is called from turn_end. If an accepted pass set
  // awaiting_validation during the previous turn_end, reaching this call again
  // already proves that one complete provider turn consumed the pruned prompt.
  //
  // Do not re-arm merely because usage slipped below Pi's native ceiling.
  // Require a lower hysteresis boundary so marginal edge prunes cannot chatter
  // around the compaction threshold and repeatedly invalidate llama.cpp's
  // cached prompt prefix.
  if (state === "awaiting_validation") {
    return canRearm ? "armed" : "exhausted";
  }

  if (state === "exhausted" && canRearm) return "armed";
  return state;
}

/**
 * Auto-evaluate only when Pi's own real context usage is past its configured
 * safe-input ceiling, this pressure episode is armed, and there is genuinely
 * new eligible tool output to score.
 *
 * Manual refresh bypasses both the ceiling and episode state, but still
 * requires at least one eligible call.
 */
export function shouldEvaluateAtTurnEnd(args: {
  autoCompactionEnabled: boolean;
  overCeiling: boolean;
  pressureEpisode: PressureEpisodeState;
  forceRefresh: boolean;
  eligibleCalls: number;
  newEligibleCalls: number;
}): boolean {
  const {
    autoCompactionEnabled,
    overCeiling,
    pressureEpisode,
    forceRefresh,
    eligibleCalls,
    newEligibleCalls,
  } = args;

  if (eligibleCalls <= 0) return false;
  if (forceRefresh) return true;
  return (
    autoCompactionEnabled &&
    overCeiling &&
    pressureEpisode === "armed" &&
    newEligibleCalls > 0
  );
}

/**
 * Cancel Pi's pending threshold compaction only while an accepted Jev pass is
 * waiting for one real post-turn usage measurement, or when Pi asks to compact
 * even though current real usage is already inside its own safe ceiling.
 *
 * Once an episode is exhausted, usage above the ceiling is never cancelled:
 * native compaction must be allowed to run.
 */
export function shouldCancelNativeThreshold(args: {
  pressureEpisode: PressureEpisodeState;
  usageTokens: number | null;
  ceilingTokens: number | null;
}): boolean {
  const { pressureEpisode, usageTokens, ceilingTokens } = args;
  if (pressureEpisode === "awaiting_validation") return true;
  return (
    usageTokens !== null &&
    ceilingTokens !== null &&
    Number.isFinite(usageTokens) &&
    Number.isFinite(ceilingTokens) &&
    usageTokens <= ceilingTokens
  );
}
