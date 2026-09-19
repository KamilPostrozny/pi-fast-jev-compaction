import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "extensions", "fast-jev.ts"), "utf8");

function blockBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("context hook is apply-only and never evaluates Jev", () => {
  const block = blockBetween(
    'pi.on("context"',
    'pi.on("session_before_compact"',
  );
  assert.doesNotMatch(block, /evaluateAtTurnEnd\s*\(/);
  assert.doesNotMatch(block, /compactMessages\s*\(/);
  assert.doesNotMatch(block, /evaluation_start/);
  assert.match(block, /applyDecisionsDetailed\s*\(/);
});

test("turn_end owns active Jev evaluation", () => {
  const block = blockBetween(
    'pi.on("turn_end"',
    'pi.on("agent_end"',
  );
  assert.match(block, /await evaluateAtTurnEnd\s*\(/);
});

test("agent_end promotes deferred full deletions only after clean stop", () => {
  const block = blockBetween(
    'pi.on("agent_end"',
    'pi.on("agent_settled"',
  );
  assert.match(block, /finalStopReason !== "stop"/);
  assert.match(block, /action: "drop_call"/);
  assert.match(block, /deferredDropCalls\.clear\(\)/);
});

test("drop_result uses an explicit pruned marker without retaining a source prefix", () => {
  assert.match(source, /result pruned/);
  assert.doesNotMatch(source, /truncateResultText/);
  assert.doesNotMatch(source, /PI_JEV_TRUNCATE_HEAD_CHARS/);
  assert.doesNotMatch(source, /text\.slice\(0,\s*headChars\)/);
});

test("automatic thresholds come from Pi compaction settings, not extension constants", () => {
  assert.match(source, /SettingsManager\.create/);
  assert.match(source, /getCompactionSettings/);
  assert.match(source, /realContextBoundary/);
  assert.doesNotMatch(source, /PI_JEV_COMPACT_AT_PERCENT/);
  assert.doesNotMatch(source, /PI_JEV_NATIVE_FALLBACK_PERCENT/);
  assert.doesNotMatch(source, /PI_JEV_REEVALUATE_/);
  assert.doesNotMatch(source, /minReductionRatio/);
});

test("normal scheduling uses Pi real usage while local estimate is diagnostic only", () => {
  const evaluateBlock = blockBetween(
    "async function evaluateAtTurnEnd",
    "export default function fastJevCompaction",
  );
  assert.match(evaluateBlock, /piCompactionBoundary\(ctx\)/);
  assert.match(evaluateBlock, /boundary\?\.overCeiling/);
  assert.match(evaluateBlock, /shouldEvaluateAtTurnEnd\(\{/);
  assert.doesNotMatch(evaluateBlock, /logicalPercent.*shouldEvaluateAtTurnEnd/s);
});

test("native threshold uses real usage and one stale-usage refresh exception", () => {
  const compactHook = blockBetween(
    'pi.on("session_before_compact"',
    'pi.on("session_compact"',
  );
  assert.match(compactHook, /piCompactionBoundary\(ctx\)/);
  assert.match(compactHook, /shouldCancelNativeThreshold\(\{/);
  assert.match(compactHook, /awaitingUsageRefresh/);
  assert.doesNotMatch(compactHook, /logicalContextAtCompaction/);
  assert.doesNotMatch(compactHook, /nativeFallbackPercent/);
});

test("successful provider response clears stale usage marker", () => {
  const block = blockBetween(
    'pi.on("after_provider_response"',
    'pi.on("turn_start"',
  );
  assert.match(block, /refreshedUsage/);
  assert.match(block, /state\.awaitingUsageRefresh = false/);
});

test("0.6 grounding/read-pinning experiments remain absent", () => {
  assert.doesNotMatch(source, /latestReadEvidenceIds/);
  assert.doesNotMatch(source, /readEvidenceKey/);
  assert.doesNotMatch(source, /GROUNDING_REMINDER/);
  assert.doesNotMatch(source, /fast-jev-grounding/);
  assert.doesNotMatch(source, /protectedReadEvidence/);
});

test("Pi adapter TypeScript parses after type stripping", () => {
  assert.doesNotThrow(() => {
    stripTypeScriptTypes(source, { mode: "transform" });
  });
});
