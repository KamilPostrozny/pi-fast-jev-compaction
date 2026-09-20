import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as core from "../extensions/fast-jev-core.ts";
import * as policy from "../extensions/policy.ts";
import * as excerpts from "../extensions/task-excerpts.ts";
import * as scoring from "../extensions/scoring-diagnostics.ts";

// Execute the actual adapter with fake Pi services, real policy/core, and mocked
// Jev HTTP. No installed Pi packages, credentials, network, or log writes needed.
const source = readFileSync(new URL("../extensions/fast-jev.ts", import.meta.url), "utf8");
const executable = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";/g,
    (_match, names, specifier) => `const {${names}} = modules[${JSON.stringify(specifier)}];`)
  .replace(/export default function /g, "function ")
  .replace(/export function /g, "function ");
const loadAdapter = new Function("modules", `${executable}\nreturn fastJevCompaction;`);

type RecordData = Record<string, any>;

function harness(t: TestContext, options: { window?: number; reserve?: number; enabled?: boolean; resultRepeats?: number } = {}) {
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_JEV_")) delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = "test-only-not-a-real-key";
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PI_JEV_") || key === "TYPESAFE_API_KEY") delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (key.startsWith("PI_JEV_") || key === "TYPESAFE_API_KEY") process.env[key] = value;
    }
  });

  const records: RecordData[] = [];
  class FakeDiagnostics {
    file = "test-log";
    record(event: string, data: RecordData = {}) { records.push({ event, ...data }); }
  }
  const settings = { enabled: options.enabled ?? true, reserveTokens: options.reserve ?? 16_384 };
  const messages: RecordData[] = [{ role: "user", content: [{ type: "text", text: "Fix the test" }] }];
  const entries: RecordData[] = [];
  const handlers = new Map<string, Function>();
  const commands = new Map<string, RecordData>();
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: RecordData) => commands.set(name, command),
    appendEntry: (customType: string, data: RecordData) => entries.push({ type: "custom", customType, data }),
  };
  let tokens: number | null = 97_000;
  let nextId = 0;
  let turnIndex = 0;
  let httpCalls = 0;
  let response: "prune" | "keep" | "fail" = "prune";
  const ctx = {
    cwd: "/test",
    hasUI: true,
    mode: "print",
    model: { provider: "test", id: "local", contextWindow: options.window ?? 112_640 },
    isProjectTrusted: () => true,
    getSystemPrompt: () => "Test system prompt",
    getContextUsage: () => ({ tokens, contextWindow: ctx.model.contextWindow }),
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => entries,
      buildSessionContext: () => ({ messages }),
    },
    ui: { setStatus() {}, notify: (text: string) => notifications.push(text) },
  };
  function addToolTurn(stopReason = "toolUse", usage: RecordData = { totalTokens: 100 }) {
    const id = `call-${++nextId}`;
    const assistant = {
      role: "assistant", stopReason, usage,
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
    };
    const result = {
      role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: "source evidence ".repeat(options.resultRepeats ?? 1200) }],
    };
    messages.push(assistant, result);
    return { message: assistant, toolResults: [result] };
  }
  for (let i = 0; i < 10; i++) addToolTurn();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    httpCalls++;
    if (response === "fail") throw new Error("test Jev outage");
    const { questions } = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.keys(questions).map(key => [key, { noul: response === "keep" ? 1 : 0.1 }]));
    return new Response(JSON.stringify({ answers }), { status: 200 });
  });
  const factory = loadAdapter({
    "@earendil-works/pi-coding-agent": {
      getAgentDir: () => "/test-agent",
      SettingsManager: { create: () => ({ getCompactionSettings: () => settings }) },
    },
    "./fast-jev-core.ts": core,
    "./diagnostics.ts": { Diagnostics: FakeDiagnostics },
    "./policy.ts": policy,
    "./task-excerpts.ts": excerpts,
    "./scoring-diagnostics.ts": scoring,
  });
  factory(pi);
  const emit = (event: string, data: RecordData = {}) => handlers.get(event)!(data, ctx);
  emit("session_start", { reason: "startup" });
  return {
    records, entries, ctx, settings, notifications, messages, emit,
    addRead(path: string, text: string, isError = false) {
      const id = `call-${++nextId}`;
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] },
        { role: "toolResult", toolCallId: id, toolName: "read", isError, content: [{ type: "text", text }] },
      );
      return id;
    },
    httpCalls: () => httpCalls,
    response: (value: typeof response) => { response = value; },
    command: (name: string) => commands.get(name)!.handler("", ctx),
    context: () => emit("context", { messages }),
    compact: (reason = "threshold") => emit("session_before_compact", {
      reason, branchEntries: entries, willRetry: false,
      preparation: { messagesToSummarize: messages, turnPrefixMessages: [], fileOps: {} },
    }),
    async turn(usageTokens: number | null, stopReason = "toolUse", usage: RecordData = { totalTokens: 100 }) {
      tokens = usageTokens;
      await emit("context", { messages });
      const event = addToolTurn(stopReason, usage);
      await emit("turn_end", { ...event, turnIndex: turnIndex++ });
    },
    last: (event: string) => records.filter(record => record.event === event).at(-1)!,
  };
}

test("real hooks: meaningful reclaim permits another episode, failed validation lets native win", async t => {
  const h = harness(t);
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 1);
  assert.equal(h.last("evaluation_success").pressureEpisode, "awaiting_validation");
  assert.deepEqual(h.compact(), { cancel: true });
  const applied = await h.context();
  assert.ok(JSON.stringify(applied.messages).includes("result pruned"));
  assert.ok(!JSON.stringify(h.messages).includes("result pruned"), "persisted transcript remains untouched");

  await h.turn(90_115);
  assert.equal(h.last("turn_evaluation_check").pressureEpisode, "armed");
  assert.equal(h.httpCalls(), 1);
  assert.equal(h.last("pressure_episode_validated").rearmTokens, 90_624);
  assert.equal(h.last("pressure_episode_validated").hysteresisMarginTokens, 5_632);
  await h.turn(96_268);
  assert.equal(h.httpCalls(), 2);
  assert.deepEqual(h.compact(), { cancel: true });
  await h.turn(96_967);
  assert.equal(h.last("turn_evaluation_check").pressureEpisode, "exhausted");
  assert.equal(h.compact(), undefined);
  await h.turn(100_987);
  assert.equal(h.httpCalls(), 2, "new results cannot bypass exhausted validation");
});

test("real hooks: marginal reclaim stays disarmed, manual refresh still works", async t => {
  const h = harness(t);
  await h.turn(97_000);
  await h.turn(95_000);
  assert.equal(h.last("pressure_episode_validated").outcome, "jev_below_ceiling_but_disarmed");
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 1);
  assert.equal(h.compact(), undefined);
  await h.command("jev-refresh");
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 2);
  assert.equal(h.last("evaluation_success").automaticPressureAttempt, false);
});

test("real hooks: 32k validation below 70 percent but above ceiling cannot retry", async t => {
  const h = harness(t, { window: 32_768 });
  await h.turn(20_000);
  await h.turn(20_000);
  assert.equal(h.httpCalls(), 1);
  assert.equal(h.last("pressure_episode_validated").outcome, "jev_failed_to_restore_ceiling");
  assert.equal(h.compact(), undefined);
});

for (const [label, stopReason, usage] of [
  ["error", "error", { totalTokens: 100 }],
  ["abort", "aborted", { totalTokens: 100 }],
  ["all-zero usage", "stop", { totalTokens: 0 }],
] as const) {
  test(`real hooks: ${label} cannot validate stale below-boundary usage`, async t => {
    const h = harness(t);
    await h.turn(97_000);
    await h.turn(60_000, stopReason, usage);
    assert.equal(h.last("pressure_episode_validated").outcome, "jev_validation_usage_unavailable");
    assert.equal(h.last("turn_evaluation_check").pressureEpisode, "exhausted");
    await h.turn(97_000);
    assert.equal(h.httpCalls(), 1);
    assert.equal(h.compact(), undefined);
  });
}

test("real hooks: unavailable Pi usage exhausts pending validation", async t => {
  const h = harness(t);
  await h.turn(97_000);
  await h.turn(null);
  assert.equal(h.last("pressure_episode_validated").outcome, "jev_validation_usage_unavailable");
  assert.equal(h.compact(), undefined);
});

for (const response of ["keep", "fail"] as const) {
  test(`real hooks: Jev ${response} consumes attempt and leaves native compaction enabled`, async t => {
    const h = harness(t);
    h.response(response);
    await h.turn(97_000);
    assert.equal(h.compact(), undefined);
    await h.turn(98_000);
    assert.equal(h.httpCalls(), 1);
    assert.equal(h.last("turn_evaluation_check").pressureEpisode, "exhausted");
  });
}

test("real hooks: manual/overflow compaction never cancelled, native completion resets episode", async t => {
  const h = harness(t);
  await h.turn(97_000);
  assert.equal(h.compact("manual"), undefined);
  assert.equal(h.compact("overflow"), undefined);
  await h.emit("session_compact", { reason: "threshold" });
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 2);
});

test("real hooks: model/reserve changes use a freshly resolved boundary", async t => {
  const h = harness(t);
  await h.turn(97_000);
  h.ctx.model.contextWindow = 65_536;
  h.settings.reserveTokens = 24_576;
  await h.turn(45_000);
  assert.equal(h.last("turn_evaluation_check").ceilingTokens, 40_960);
  assert.equal(h.last("turn_evaluation_check").rearmTokens, 37_683);
  assert.equal(h.last("turn_evaluation_check").pressureEpisode, "exhausted");
  assert.equal(h.httpCalls(), 1);
});

test("real hooks: disabled auto-compaction and missing key fail open", async t => {
  const h = harness(t, { enabled: false });
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 0);
  h.settings.enabled = true;
  delete process.env.TYPESAFE_API_KEY;
  await h.turn(97_000);
  assert.equal(h.last("evaluation_skipped").reason, "missing_api_key");
  assert.equal(h.compact(), undefined);
  assert.equal(h.httpCalls(), 0);
});

test("real hooks: reload preserves pruning and explicitly starts a new armed episode", async t => {
  const h = harness(t);
  await h.turn(97_000);
  await h.turn(95_000);
  await h.emit("session_start", { reason: "reload" });
  assert.ok(h.last("session_start").restored > 0);
  const applied = await h.context();
  assert.ok(JSON.stringify(applied.messages).includes("result pruned"));
  await h.turn(97_000);
  assert.equal(h.httpCalls(), 2);
});

test("status and diagnostics identify the new version and resolved re-arm boundary", async t => {
  const h = harness(t);
  assert.equal(h.last("extension_loaded").version, "0.7.4");
  assert.equal(h.last("session_start").sessionId, "test-session");
  assert.equal(h.last("session_start").apiKeyConfigured, true);
  await h.command("jev-status");
  assert.match(h.notifications.at(-1)!, /80\.45%/);
  assert.doesNotMatch(h.notifications.at(-1)!, /re-arm≤70%/);
});

test("real hooks: small automatic prune is rejected without mutating history or deferring native", async t => {
  const h = harness(t, { resultRepeats: 30 });
  await h.turn(97_000);
  const result = h.last("evaluation_success");
  assert.ok(result.changedResults > 0);
  assert.ok(result.estimatedSavedTokens > 0);
  assert.ok(result.estimatedSavedTokens < 5_632);
  assert.equal(result.minimumSavedTokens, 5_632);
  assert.equal(result.accepted, false);
  assert.equal(result.acceptanceReason, "insufficient_estimated_savings");
  assert.equal(h.entries.length, 0);
  assert.equal(h.compact(), undefined);
  assert.ok(!JSON.stringify((await h.context())?.messages ?? h.messages).includes("result pruned"));
  await h.turn(98_000);
  assert.equal(h.httpCalls(), 1, "rejection consumes the automatic episode");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(h.entries.length, 0, "rejected full deletions cannot be promoted later");
});

test("real hooks: manual refresh bypasses the automatic savings floor", async t => {
  const h = harness(t, { resultRepeats: 30 });
  await h.command("jev-refresh");
  await h.turn(70_000);
  assert.equal(h.last("evaluation_success").accepted, true);
  assert.equal(h.last("evaluation_success").acceptanceReason, "manual_override");
  assert.ok(JSON.stringify(await h.context()).includes("result pruned"));
});

test("real hooks: savings use net logical results, not historical deletions", async t => {
  const h = harness(t);
  await h.turn(97_000);
  await h.turn(50_000); // one newly eligible result, smaller than the margin
  const committed = JSON.stringify(h.entries.at(-1));
  await h.command("jev-refresh");
  await h.turn(50_000);
  // Commit a manual refresh to leave only one newly eligible result at next crossing.
  assert.equal(h.last("evaluation_success").accepted, true);
  const afterManual = JSON.stringify(h.entries.at(-1));
  assert.notEqual(afterManual, committed);
  await h.turn(97_000); // validation fails: cannot run another automatic pass
  await h.turn(50_000); // re-arm; another two turns accumulate enough output
  await h.turn(97_000);
  const result = h.last("evaluation_success");
  assert.ok(result.estimatedSavedTokens < 15_000, "old savings must not be counted again");
  assert.ok(h.last("evaluation_scores").previouslyPruned.calls > 0);
});

const taskWarning = "- Keep-mine outbox race reproduced on the base commit.\n  Not a regression; out of scope for this task.";
const taskStatus = `# Task status\n\n## Next task\n\nImplement duty actions.\n\n## Implementation history\n\n${"old implementation details ".repeat(1000)}\n\n## Constraints and open edges\n\n${taskWarning}\n`;

async function ageReadAndPrune(h: ReturnType<typeof harness>) {
  await h.turn(80_000);
  await h.turn(80_000);
  await h.turn(97_000);
}

test("real hooks: task excerpts survive re-scoring, reload, clean end, and native summarization", async t => {
  const h = harness(t);
  const id = h.addRead("docs/increment-3-status.md", taskStatus);
  await ageReadAndPrune(h);
  const saved = h.entries.at(-1)!.data.decisions.find((d: RecordData) => d.toolCallId === id);
  assert.ok(saved.retainedExcerpt.includes(taskWarning));
  assert.ok(saved.retainedExcerpt.length <= excerpts.MAX_TASK_EXCERPT_CHARS);
  const projected = await h.context();
  const read = projected.messages.find((m: RecordData) => m.toolCallId === id);
  assert.ok(read.content[0].text.includes(taskWarning));
  assert.ok(!read.content[0].text.includes("old implementation details"));
  const volume = (messages: RecordData[]) => messages
    .filter(m => m.role === "toolResult")
    .reduce((sum, m) => sum + core.estimateTokens(m.content[0].text), 0);
  assert.equal(h.last("evaluation_success").estimatedSavedTokens,
    volume(h.messages) - volume(projected.messages), "the savings gate charges retained excerpts");
  assert.ok(h.messages.find(m => m.toolCallId === id)!.content[0].text.includes("old implementation details"));
  await h.turn(50_000);
  await h.command("jev-refresh");
  await h.turn(50_000);
  const rescored = h.entries.at(-1)!.data.decisions.find((d: RecordData) => d.toolCallId === id);
  assert.equal(rescored.retainedExcerpt, saved.retainedExcerpt);
  await h.emit("session_start", { reason: "reload" });
  await h.command("jev-refresh");
  await h.turn(50_000);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  const afterEnd = await h.context();
  assert.ok(JSON.stringify(afterEnd.messages).includes("Keep-mine outbox race"));
  const preparation = { messagesToSummarize: h.messages, turnPrefixMessages: [], fileOps: {} };
  await h.emit("session_before_compact", { reason: "manual", preparation, branchEntries: h.entries });
  assert.ok(JSON.stringify(preparation.messagesToSummarize).includes("Keep-mine outbox race"));
  const sanitized = preparation.messagesToSummarize.find(m => m.toolCallId === id);
  assert.ok(!sanitized!.content[0].text.includes("old implementation details"));
});

test("real hooks: ordinary source and errored status reads still use plain pruning", async t => {
  const h = harness(t);
  const source = h.addRead("src/status.ts", taskStatus);
  const failed = h.addRead("docs/status.md", taskStatus, true);
  await ageReadAndPrune(h);
  const projected = await h.context();
  for (const id of [source, failed]) {
    const result = projected.messages.find((m: RecordData) => m.toolCallId === id);
    assert.ok(result.content[0].text.startsWith("[fast-jev-compaction: result pruned"));
    assert.ok(!result.content[0].text.includes("Keep-mine"));
  }
});

test("real hooks: excerpt budgets hold across multiple passes and reloads", async t => {
  const h = harness(t);
  const status = `## Known issues\n\n${"- A known regression needs baseline verification.\n".repeat(100)}\n\n${taskStatus}`;
  for (let i = 0; i < 12; i++) h.addRead(`docs/task-${i}-status.md`, status);
  await ageReadAndPrune(h);
  const first = h.last("evaluation_success").retainedTaskExcerpts;
  assert.ok(first.results > 0);
  assert.ok(first.chars <= excerpts.MAX_TASK_EXCERPTS_TOTAL_CHARS);
  await h.emit("session_start", { reason: "reload" });
  for (let i = 12; i < 16; i++) h.addRead(`docs/task-${i}-status.md`, status);
  await ageReadAndPrune(h);
  const last = h.last("evaluation_success").retainedTaskExcerpts;
  assert.ok(last.chars <= excerpts.MAX_TASK_EXCERPTS_TOTAL_CHARS);
  for (const decision of h.entries.at(-1)!.data.decisions) {
    assert.ok((decision.retainedExcerpt?.length ?? 0) <= excerpts.MAX_TASK_EXCERPT_CHARS);
  }
});

test("real hooks: rejected proposals cannot commit even useful task excerpts", async t => {
  const h = harness(t, { resultRepeats: 30 });
  h.addRead("docs/status.md", `## Known issues\n\n${taskWarning}`);
  await ageReadAndPrune(h);
  assert.equal(h.last("evaluation_success").accepted, false);
  assert.ok(h.last("evaluation_success").proposedTaskExcerpts.results > 0);
  assert.equal(h.last("evaluation_success").retainedTaskExcerpts.results, 0);
  assert.equal(h.entries.length, 0);
});

test("real hooks: upgrading cannot resurrect status text already pruned by older versions", async t => {
  const h = harness(t);
  const id = h.addRead("docs/status.md", taskStatus);
  h.entries.push({ type: "custom", customType: "fast-jev-compaction-state", data: {
    version: 1, cause: "legacy", savedAt: new Date().toISOString(),
    decisions: [{ toolCallId: id, action: "drop_result", keepCall: 0.1, keepResult: 0.1 }],
  } });
  await h.emit("session_start", { reason: "reload" });
  await ageReadAndPrune(h);
  const restored = (await h.context()).messages.find((m: RecordData) => m.toolCallId === id);
  assert.ok(!restored.content[0].text.includes("Keep-mine"));
  assert.ok(!h.entries.at(-1)!.data.decisions.find((d: RecordData) => d.toolCallId === id).retainedExcerpt);
});

test("real hooks: scoring diagnostics distinguish parsed probabilities without logging content", async t => {
  const h = harness(t);
  await h.turn(97_000);
  const scores = h.last("evaluation_scores");
  assert.equal(scores.keepThreshold, 0.5);
  assert.equal(scores.resultVisibility, "metadata_only");
  assert.ok(scores.scored.calls > 0);
  assert.equal(scores.scored.keepResult.min, 0.1);
  assert.equal(scores.scored.keepResult.max, 0.1);
  assert.equal(scores.scored.keep, 0);
  assert.equal(scores.previouslyPruned.calls, 0);
  assert.ok(scores.pinned > 0);
  assert.ok(!JSON.stringify(scores).includes("source evidence"));
  assert.equal(h.last("evaluation_goal").source, "recent_user_prompts");
});
