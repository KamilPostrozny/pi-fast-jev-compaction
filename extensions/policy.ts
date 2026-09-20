import type { CallAction } from "./fast-jev-core.ts";

export type PressureEpisodeState =
  | "armed"
  | "awaiting_validation"
  | "exhausted";

export interface RealContextBoundary {
  tokens: number | null;
  contextWindow: number;
  reserveTokens: number;
  ceilingTokens: number;
  rearmTokens: number;
  hysteresisMarginTokens: number;
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

  const reserve = Math.max(0, Number.isFinite(reserveTokens) ? reserveTokens : 0);
  const ceilingTokens = contextCeiling(contextWindow, reserve);
  // Round the re-arm boundary down, never towards the native ceiling.
  const rearmTokens = Math.max(
    0,
    Math.floor(ceilingTokens - Math.min(contextWindow * 0.05, reserve / 2)),
  );
  const realTokens =
    tokens !== null && tokens !== undefined && Number.isFinite(tokens)
      ? Math.max(0, tokens)
      : null;

  return {
    tokens: realTokens,
    contextWindow,
    reserveTokens: reserve,
    ceilingTokens,
    rearmTokens,
    hysteresisMarginTokens: ceilingTokens - rearmTokens,
    percent: realTokens === null ? null : (realTokens / contextWindow) * 100,
    overCeiling: realTokens !== null && realTokens > ceilingTokens,
  };
}

/** Pi skips failed/all-zero assistant usage and otherwise falls back to older usage. */
export function hasFreshAssistantUsage(message: {
  role?: string;
  stopReason?: string;
  usage?: {
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): boolean {
  if (
    message.role !== "assistant" ||
    !["stop", "toolUse", "length"].includes(message.stopReason ?? "")
  ) return false;
  const usage = message.usage;
  if (!usage) return false;
  const tokens = usage.totalTokens || (
    (usage.input ?? 0) + (usage.output ?? 0) +
    (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
  return Number.isFinite(tokens) && tokens > 0;
}

export function acceptsReduction(changedResults: number): boolean {
  return Number.isFinite(changedResults) && changedResults > 0;
}

/** A cost gate, not a substitute for Pi usage or next-turn validation. */
export function pruningAcceptance(args: {
  changedResults: number;
  estimatedSavedTokens: number;
  automatic: boolean;
  boundary: RealContextBoundary | null;
}): { accepted: boolean; reason: string; minimumSavedTokens: number | null } {
  const minimumSavedTokens = args.automatic
    ? args.boundary?.hysteresisMarginTokens ?? null
    : 0;
  if (!acceptsReduction(args.changedResults)) {
    return { accepted: false, reason: "no_actual_pruning", minimumSavedTokens };
  }
  if (!args.automatic) {
    return { accepted: true, reason: "manual_override", minimumSavedTokens };
  }
  if (minimumSavedTokens === null || !Number.isFinite(args.estimatedSavedTokens) ||
      args.estimatedSavedTokens <= 0 || args.estimatedSavedTokens < minimumSavedTokens) {
    return { accepted: false, reason: "insufficient_estimated_savings", minimumSavedTokens };
  }
  return { accepted: true, reason: "worthwhile_estimated_savings", minimumSavedTokens };
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
  // Pass null after a failed turn: getContextUsage() may still report stale usage.
  boundary: RealContextBoundary | null;
}): PressureEpisodeState {
  const { state, boundary } = args;
  const tokens = boundary?.tokens;
  const canRearm =
    boundary !== null &&
    tokens !== null &&
    tokens !== undefined &&
    Number.isFinite(tokens) &&
    tokens <= boundary.rearmTokens &&
    // Zero reserve has no dead band; a zero ceiling has no safe input space.
    // Neither case may re-arm at or above Pi's ceiling.
    tokens < boundary.ceilingTokens;

  // Require meaningful headroom relative to Pi's ceiling, not a fixed fraction
  // of the entire context window. Missing/failing validation consumes the
  // attempt rather than repeatedly delaying native compaction.
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
