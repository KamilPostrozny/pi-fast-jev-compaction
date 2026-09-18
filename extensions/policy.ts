export function acceptsReduction(ratio: number, minimum: number): boolean {
  return Number.isFinite(ratio) && Number.isFinite(minimum) && ratio >= minimum;
}

export function shouldRefreshSettledEligible(
  active: boolean,
  settledGeneration: number,
  lastEvaluatedSettledGeneration: number,
  hasUnscoredEligibleCall: boolean,
): boolean {
  return (
    active &&
    settledGeneration > lastEvaluatedSettledGeneration &&
    hasUnscoredEligibleCall
  );
}

export function hasNativeHeadroom(
  logicalTokens: number,
  contextWindow: number | undefined,
  reserveTokens: number,
): boolean {
  if (!Number.isFinite(logicalTokens) || logicalTokens < 0) return false;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  if (!Number.isFinite(reserveTokens) || reserveTokens < 0) return false;
  return logicalTokens <= Math.max(0, contextWindow - reserveTokens);
}
