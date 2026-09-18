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

test("defaults keep only trigger/fallback/min-reduction policy knobs", () => {
  assert.match(source, /compactAtPercent:\s*75/);
  assert.match(source, /nativeFallbackPercent:\s*87\.5/);
  assert.match(source, /minReductionRatio:\s*0\.01/);
  assert.doesNotMatch(source, /REEVALUATE_MID_PERCENT/);
  assert.doesNotMatch(source, /REEVALUATE_URGENT_PERCENT/);
  assert.doesNotMatch(source, /REEVALUATE_.*RESULT_(TOKENS|PERCENT)/);
});

test("drop_result uses an explicit pruned marker without retaining a source prefix", () => {
  assert.match(source, /result pruned/);
  assert.match(source, /re-run this tool before relying on its output/);
  assert.doesNotMatch(source, /truncateResultText/);
  assert.doesNotMatch(source, /PI_JEV_TRUNCATE_HEAD_CHARS/);
  assert.doesNotMatch(source, /text\.slice\(0,\s*headChars\)/);
});

test("context hook never injects a recurring grounding user message", () => {
  const block = blockBetween(
    'pi.on("context"',
    'pi.on("session_before_compact"',
  );
  assert.doesNotMatch(block, /fast-jev-grounding/);
  assert.doesNotMatch(block, /appendGroundingReminder/);
  assert.doesNotMatch(source, /GROUNDING_REMINDER/);
});

test("latest successful read evidence uses the same pins for eligibility and Jev", () => {
  const evaluateBlock = blockBetween(
    "async function evaluateAtTurnEnd",
    "export default function fastJevCompaction",
  );
  assert.match(source, /function latestReadEvidenceIds/);
  assert.match(source, /block\.name !== "read"/);
  assert.match(evaluateBlock, /sourceEvidenceIds = latestReadEvidenceIds\(logicalBefore\)/);
  assert.match(evaluateBlock, /protectedToolCallIds:\s*protectedIds/);
  assert.match(
    evaluateBlock,
    /collectToolCalls\([\s\S]*evaluationProjection\.protectedToolCallIds/,
  );
  assert.match(evaluateBlock, /evaluate\(\s*evaluationProjection,/);
});

test("turn-end scheduling and native fallback share calibrated pressure", () => {
  const evaluateBlock = blockBetween(
    "async function evaluateAtTurnEnd",
    "export default function fastJevCompaction",
  );
  const compactBlock = blockBetween(
    "function logicalContextAtCompaction",
    "function failOpen",
  );
  assert.match(evaluateBlock, /pressureSnapshot\s*\(/);
  assert.match(compactBlock, /pressureSnapshot\s*\(/);
});

test("Pi adapter TypeScript parses after type stripping", () => {
  assert.doesNotThrow(() => {
    stripTypeScriptTypes(source, { mode: "transform" });
  });
});
