import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("defaults leave a gap between Jev and native fallback", () => {
  assert.match(source, /compactAtPercent:\s*80/);
  assert.match(source, /nativeFallbackPercent:\s*87\.5/);
});
