import type { CallDecision } from "./fast-jev-core.ts";

function probabilities(values: number[], threshold: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const frequency = new Map<number, number>();
  for (const value of values) {
    const rounded = Number(value.toFixed(4));
    frequency.set(rounded, (frequency.get(rounded) ?? 0) + 1);
  }
  return {
    count: values.length,
    min: sorted[0] ?? null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    max: sorted.at(-1) ?? null,
    atOrAboveThreshold: values.filter(value => value >= threshold).length,
    distinctRoundedValues: frequency.size,
    mostCommon: [...frequency].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([value, count]) => ({ value, count })),
  };
}

/** Numeric diagnostics only: never log inputs, paths, result bodies, or goals. */
export function scoringDiagnostics(
  decisions: readonly CallDecision[],
  previouslyPrunedIds: ReadonlySet<string>,
  threshold: number,
) {
  const scored = decisions.filter(decision => decision.reason !== "pinned");
  const summarize = (group: readonly CallDecision[]) => ({
    calls: group.length,
    keep: group.filter(decision => decision.action === "keep").length,
    dropResult: group.filter(decision => decision.action === "drop_result").length,
    dropCall: group.filter(decision => decision.action === "drop_call").length,
    keepCall: probabilities(group.map(decision => decision.keepCall), threshold),
    keepResult: probabilities(group.map(decision => decision.keepResult), threshold),
  });
  return {
    keepThreshold: threshold,
    resultVisibility: "metadata_only",
    pinned: decisions.length - scored.length,
    scored: summarize(scored),
    previouslyPruned: summarize(scored.filter(decision => previouslyPrunedIds.has(decision.id))),
    notPreviouslyPruned: summarize(scored.filter(decision => !previouslyPrunedIds.has(decision.id))),
    // Limit log size even if an agent registers hundreds of distinct tools.
    byTool: [...new Set(scored.map(decision => decision.tool))].slice(0, 20)
      .map(tool => ({ tool, ...summarize(scored.filter(decision => decision.tool === tool)) })),
  };
}
