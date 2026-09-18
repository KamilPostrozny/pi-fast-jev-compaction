import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  collectToolCalls,
  compactMessages,
  estimateTokens,
  reductionRatio,
  type CallAction,
  type CompactResult,
  type Message as JevMessage,
  type ToolCall as JevToolCall,
} from "./fast-jev-core.ts";
import { Diagnostics, summarizeDiagnostic } from "./diagnostics.ts";
import {
  acceptsReduction,
  activeRunAction,
  shouldDelayNativeThreshold,
  shouldEvaluateAtTurnEnd,
} from "./policy.ts";

const STATUS_KEY = "fast-jev";
const STATE_ENTRY_TYPE = "fast-jev-compaction-state";
const STATE_SCHEMA_VERSION = 1;

export interface Config {
  compactAtPercent: number;
  nativeFallbackPercent: number;
  minReductionRatio: number;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  model: string;
  baseUrl?: string;
  goal?: string;
  requestTimeoutMs: number;
  evaluationTimeoutMs: number;
  retryDelayMs: number;
  circuitBreakerFailures: number;
  circuitBreakerMs: number;
  diagnostics: boolean;
  diagnosticsFile?: string;
  diagnosticsStderr: boolean;
}

const DEFAULTS: Config = {
  compactAtPercent: 80,
  nativeFallbackPercent: 87.5,
  minReductionRatio: 0.25,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  model: "jev-latest",
  requestTimeoutMs: 8_000,
  evaluationTimeoutMs: 12_000,
  retryDelayMs: 30_000,
  circuitBreakerFailures: 2,
  circuitBreakerMs: 120_000,
  diagnostics: true,
  diagnosticsStderr: false,
};

interface CachedDecision {
  action: CallAction;
  keepCall: number;
  keepResult: number;
}

interface PersistedDecision extends CachedDecision {
  toolCallId: string;
}

interface PersistedLogicalState {
  version: 1;
  decisions: PersistedDecision[];
  savedAt: string;
  cause: string;
}

interface Projection {
  messages: JevMessage[];
  protectedToolCallIds: Set<string>;
}

interface Evaluation {
  result: CompactResult;
  calls: JevToolCall[];
  rawTokens: number;
  durationMs: number;
}

interface ApplyStats {
  droppedCalls: number;
  droppedResults: number;
  truncatedResults: number;
  messagesBefore: number;
  messagesAfter: number;
}

interface HttpSnapshot {
  httpId: number;
  status?: number;
  durationMs: number;
  timedOut: boolean;
  questionCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  error?: string;
}

interface RuntimeState {
  enabled: boolean;
  active: boolean;
  forceRefresh: boolean;
  evaluating: boolean;
  decisions: Map<string, CachedDecision>;
  lastResult?: CompactResult;
  lastError?: string;
  lastRawTokens?: number;
  lastRawPercent?: number;
  lastPiTokens?: number;
  lastPiPercent?: number;
  lastLogicalTokens?: number;
  lastLogicalPercent?: number;
  lastGrossToolCalls?: number;
  lastLogicalToolCalls?: number;
  restoredDecisionCount: number;
  insufficient: boolean;
  notifiedMissingKey: boolean;
  retryAfterMs: number;
  consecutiveFailures: number;
  breakerUntilMs: number;
  lastSuccessMs: number;
  lastEvaluationMs?: number;
  lastHttp?: HttpSnapshot;
  lastApply?: ApplyStats;
  contextHookCount: number;
  failOpenCount: number;
  thresholdCancelledCount: number;
  thresholdPassedCount: number;
  evaluationAttempts: number;
  evaluationSuccesses: number;
  totalHttpRequests: number;
  totalHttpErrors: number;
  totalHttpTimeouts: number;
  lastEvaluationRequests?: number;
  lastEvaluationEligible?: number;
  lastContextWindow?: number;
  lastContextHookId?: number;
  lastContextOutcome?: string;
  providerRequestCount: number;
  lastProviderRequestMs?: number;
  lastProviderDurationMs?: number;
  lastProviderStatus?: number;
  deferredDropCalls: Map<string, CachedDecision>;
  lastEvaluationMode?: "active_result_only" | "agent_end_promote";
  lastEffectiveReduction?: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveConfig(): Config {
  const requestTimeoutMs = Math.max(
    1_000,
    Math.floor(envNumber("PI_JEV_REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs)),
  );
  const evaluationTimeoutMs = Math.max(
    requestTimeoutMs + 1_000,
    Math.floor(envNumber("PI_JEV_EVALUATION_TIMEOUT_MS", DEFAULTS.evaluationTimeoutMs)),
  );
  const compactAtPercent = envNumber("PI_JEV_COMPACT_AT_PERCENT", DEFAULTS.compactAtPercent);
  const config: Config = {
    compactAtPercent,
    nativeFallbackPercent: Math.max(
      compactAtPercent,
      envNumber("PI_JEV_NATIVE_FALLBACK_PERCENT", DEFAULTS.nativeFallbackPercent),
    ),
    minReductionRatio: envNumber("PI_JEV_MIN_REDUCTION_RATIO", DEFAULTS.minReductionRatio),
    keepThreshold: envNumber("PI_JEV_KEEP_THRESHOLD", DEFAULTS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(envNumber("PI_JEV_PRESERVE_RECENT_MESSAGES", DEFAULTS.preserveRecentMessages)),
    ),
    maxStateTokens: Math.max(1, envNumber("PI_JEV_MAX_STATE_TOKENS", DEFAULTS.maxStateTokens)),
    maxRequestTokens: Math.max(1, envNumber("PI_JEV_MAX_REQUEST_TOKENS", DEFAULTS.maxRequestTokens)),
    truncateHeadChars: Math.max(
      0,
      Math.floor(envNumber("PI_JEV_TRUNCATE_HEAD_CHARS", DEFAULTS.truncateHeadChars)),
    ),
    model: envString("PI_JEV_MODEL") ?? DEFAULTS.model,
    requestTimeoutMs,
    evaluationTimeoutMs,
    retryDelayMs: Math.max(
      0,
      Math.floor(envNumber("PI_JEV_RETRY_DELAY_MS", DEFAULTS.retryDelayMs)),
    ),
    circuitBreakerFailures: Math.max(
      1,
      Math.floor(envNumber("PI_JEV_CIRCUIT_BREAKER_FAILURES", DEFAULTS.circuitBreakerFailures)),
    ),
    circuitBreakerMs: Math.max(
      1_000,
      Math.floor(envNumber("PI_JEV_CIRCUIT_BREAKER_MS", DEFAULTS.circuitBreakerMs)),
    ),
    diagnostics: envBoolean("PI_JEV_DIAGNOSTICS", DEFAULTS.diagnostics),
    diagnosticsStderr: envBoolean("PI_JEV_DIAGNOSTICS_STDERR", DEFAULTS.diagnosticsStderr),
  };
  const baseUrl = envString("PI_JEV_BASE_URL");
  const goal = envString("PI_JEV_GOAL");
  const diagnosticsFile = envString("PI_JEV_DIAGNOSTICS_FILE");
  if (baseUrl) config.baseUrl = baseUrl;
  if (goal) config.goal = goal;
  if (diagnosticsFile) config.diagnosticsFile = diagnosticsFile;
  return config;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "image") {
      const mime = typeof typed.mimeType === "string" ? typed.mimeType : "image";
      parts.push(`[${mime} attached]`);
    } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
      parts.push(`[assistant thinking]\n${typed.thinking}`);
    }
  }
  return parts.join("\n");
}

function toolResultHasImage(message: AgentMessage): boolean {
  if (message.role !== "toolResult") return false;
  return message.content.some((block) => block.type === "image");
}

function protectedToolIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult" && toolResultHasImage(message)) ids.add(message.toolCallId);
  }
  return ids;
}

/**
 * Converts Pi's richer AgentMessage representation into the small transcript
 * shape expected by the vendored Jev compaction core. There is exactly one
 * projected entry per Pi message so preserveRecentMessages keeps Pi indexing
 * semantics. System messages are represented as empty entries because Pi sends
 * the system prompt separately.
 */
export function projectMessages(messages: readonly AgentMessage[]): Projection {
  const protectedToolCallIds = protectedToolIds(messages);
  const projected: JevMessage[] = messages.map((message): JevMessage => {
    switch (message.role) {
      case "assistant": {
        const toolUses = message.content
          .filter(
            (block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
              block.type === "toolCall",
          )
          .map((block) => ({
            tool_use_id: block.id,
            tool: block.name,
            input: block.arguments ?? {},
          }));
        return { role: "assistant", text: textContent(message.content), toolUses };
      }
      case "toolResult":
        return {
          role: "user",
          text: "",
          toolUses: [],
          toolResults: [
            {
              tool_use_id: message.toolCallId,
              text: protectedToolCallIds.has(message.toolCallId)
                ? "[image-bearing tool result protected from Jev pruning]"
                : textContent(message.content),
              isError: message.isError,
            },
          ],
        };
      case "user":
        return { role: "user", text: textContent(message.content), toolUses: [] };
      case "bashExecution":
        return {
          role: "user",
          text: message.excludeFromContext
            ? ""
            : `[shell command]\n${message.command}\n[shell output]\n${message.output}`,
          toolUses: [],
        };
      case "custom":
        return { role: "user", text: textContent(message.content), toolUses: [] };
      case "branchSummary":
        return { role: "user", text: `[branch summary]\n${message.summary}`, toolUses: [] };
      case "compactionSummary":
        return { role: "user", text: `[previous compaction summary]\n${message.summary}`, toolUses: [] };
      case "system":
        return { role: "user", text: "", toolUses: [] };
      default:
        return { role: "user", text: "", toolUses: [] };
    }
  });
  return { messages: projected, protectedToolCallIds };
}

function inferGoal(messages: readonly AgentMessage[]): string {
  const prompts = messages
    .filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user")
    .map((message) => textContent(message.content).trim())
    .filter(Boolean)
    .slice(-3)
    .map((text) => (text.length <= 500 ? text : `${text.slice(0, 499)}…`));
  return prompts.join("\n");
}

function rawToolCallIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") ids.add(block.id);
    }
  }
  return ids;
}

function decisionIds(decisions: ReadonlyMap<string, CachedDecision>): Set<string> {
  return new Set(decisions.keys());
}

function rawTokenEstimate(projected: readonly JevMessage[], ctx: ExtensionContext): number {
  const conversation = estimateTokens(JSON.stringify(projected));
  const system = estimateTokens(ctx.getSystemPrompt());
  return conversation + system;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function truncateResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`;
}

function applyDecisionsDetailed(
  messages: readonly AgentMessage[],
  decisions: ReadonlyMap<string, CachedDecision>,
  eligibleIds: ReadonlySet<string>,
  truncateHeadChars: number,
): { messages: AgentMessage[]; stats: ApplyStats } {
  const output: AgentMessage[] = [];
  let droppedCalls = 0;
  let droppedResults = 0;
  let truncatedResults = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      let touched = false;
      const content = message.content.filter((block) => {
        if (block.type !== "toolCall" || !eligibleIds.has(block.id)) return true;
        const decision = decisions.get(block.id);
        if (decision?.action !== "drop_call") return true;
        touched = true;
        droppedCalls += 1;
        return false;
      });
      if (!touched) {
        output.push(message);
      } else if (content.length > 0) {
        output.push({ ...message, content });
      }
      continue;
    }

    if (message.role === "toolResult" && eligibleIds.has(message.toolCallId)) {
      const decision = decisions.get(message.toolCallId);
      if (decision?.action === "drop_call") {
        droppedResults += 1;
        continue;
      }
      if (decision?.action === "drop_result") {
        const original = textContent(message.content);
        const truncated = truncateResultText(original, message.isError, truncateHeadChars);
        if (truncated !== original) {
          truncatedResults += 1;
          output.push({
            ...message,
            content: [{ type: "text", text: truncated }],
          });
          continue;
        }
      }
    }
    output.push(message);
  }

  return {
    messages: output,
    stats: {
      droppedCalls,
      droppedResults,
      truncatedResults,
      messagesBefore: messages.length,
      messagesAfter: output.length,
    },
  };
}

/** Apply Jev decisions to a copied Pi context without changing the session transcript. */
export function applyDecisionsToPi(
  messages: readonly AgentMessage[],
  decisions: ReadonlyMap<string, CachedDecision>,
  eligibleIds: ReadonlySet<string>,
  truncateHeadChars: number,
): AgentMessage[] {
  return applyDecisionsDetailed(messages, decisions, eligibleIds, truncateHeadChars).messages;
}

function decisionMap(result: CompactResult, calls: readonly JevToolCall[]): Map<string, CachedDecision> {
  const callByShortId = new Map(calls.map((call) => [call.id, call]));
  const out = new Map<string, CachedDecision>();
  for (const decision of result.decisions) {
    if (decision.reason === "pinned") continue;
    const call = callByShortId.get(decision.id);
    if (!call) continue;
    out.set(call.tool_use_id, {
      action: decision.action,
      keepCall: decision.keepCall,
      keepResult: decision.keepResult,
    });
  }
  return out;
}

function activeDecisionMaps(
  result: CompactResult,
  calls: readonly JevToolCall[],
): {
  committed: Map<string, CachedDecision>;
  deferredDropCalls: Map<string, CachedDecision>;
} {
  const full = decisionMap(result, calls);
  const committed = new Map<string, CachedDecision>();
  const deferredDropCalls = new Map<string, CachedDecision>();
  for (const [id, decision] of full) {
    if (decision.action === "drop_call") deferredDropCalls.set(id, decision);
    committed.set(id, { ...decision, action: activeRunAction(decision.action) });
  }
  return { committed, deferredDropCalls };
}

function projectedChars(messages: readonly JevMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const tool of message.toolUses) {
      try {
        total += JSON.stringify(tool.input).length;
      } catch {
        total += 20;
      }
    }
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}

function activeReductionRatio(
  messages: readonly AgentMessage[],
  decisions: ReadonlyMap<string, CachedDecision>,
  truncateHeadChars: number,
): number {
  const before = projectMessages(messages).messages;
  const afterPi = applyDecisionsDetailed(
    messages,
    decisions,
    decisionIds(decisions),
    truncateHeadChars,
  ).messages;
  const after = projectMessages(afterPi).messages;
  const charsBefore = projectedChars(before);
  return charsBefore === 0 ? 0 : (charsBefore - projectedChars(after)) / charsBefore;
}

const ACTION_RANK: Record<CallAction, number> = { keep: 0, drop_result: 1, drop_call: 2 };

/**
 * Merge a new Jev pass into the already committed logical history. Decisions
 * are monotonic: a call may become less detailed over time, but previously
 * deleted information can never be resurrected from Pi's persisted transcript.
 */
function mergeMonotonicDecisions(
  existing: ReadonlyMap<string, CachedDecision>,
  proposed: ReadonlyMap<string, CachedDecision>,
  rawIds: ReadonlySet<string>,
): Map<string, CachedDecision> {
  const merged = new Map<string, CachedDecision>();
  for (const [id, decision] of existing) {
    if (rawIds.has(id)) merged.set(id, decision);
  }
  for (const [id, next] of proposed) {
    if (!rawIds.has(id)) continue;
    const previous = merged.get(id);
    if (!previous || ACTION_RANK[next.action] >= ACTION_RANK[previous.action]) {
      merged.set(id, next);
    }
  }
  return merged;
}

function persistedState(state: RuntimeState, cause: string): PersistedLogicalState {
  return {
    version: STATE_SCHEMA_VERSION,
    // Only destructive decisions are required to reconstruct the logical
    // transcript after /reload. `keep` is an in-memory scoring cache, not
    // logical history, and persisting it would make session state grow quickly.
    decisions: [...state.decisions.entries()]
      .filter(([, decision]) => decision.action !== "keep")
      .map(([toolCallId, decision]) => ({ toolCallId, ...decision }))
      .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)),
    savedAt: new Date().toISOString(),
    cause,
  };
}

function persistLogicalState(
  pi: ExtensionAPI,
  diagnostics: Diagnostics,
  state: RuntimeState,
  cause: string,
): void {
  try {
    const data = persistedState(state, cause);
    pi.appendEntry<PersistedLogicalState>(STATE_ENTRY_TYPE, data);
    diagnostics.record("logical_state_persisted", {
      cause,
      decisions: data.decisions.length,
      droppedCalls: data.decisions.filter((decision) => decision.action === "drop_call").length,
      droppedResults: data.decisions.filter((decision) => decision.action === "drop_result").length,
    });
  } catch (error) {
    diagnostics.record("logical_state_persist_failed", { cause, error: errorText(error) });
  }
}

function restoreLogicalState(
  ctx: ExtensionContext,
  diagnostics: Diagnostics,
  state: RuntimeState,
): void {
  let saved: PersistedLogicalState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<PersistedLogicalState> | undefined;
    if (data?.version !== STATE_SCHEMA_VERSION || !Array.isArray(data.decisions)) continue;
    saved = data as PersistedLogicalState;
  }

  const restored = new Map<string, CachedDecision>();
  for (const decision of saved?.decisions ?? []) {
    if (!decision || typeof decision.toolCallId !== "string") continue;
    if (!(["keep", "drop_result", "drop_call"] as string[]).includes(decision.action)) continue;
    if (typeof decision.keepCall !== "number" || typeof decision.keepResult !== "number") continue;
    restored.set(decision.toolCallId, {
      action: decision.action,
      keepCall: decision.keepCall,
      keepResult: decision.keepResult,
    });
  }

  state.decisions = restored;
  state.restoredDecisionCount = restored.size;
  state.lastResult = undefined;
  state.lastError = undefined;
  state.insufficient = false;
  state.forceRefresh = false;
  state.retryAfterMs = 0;
  state.consecutiveFailures = 0;
  state.breakerUntilMs = 0;
  state.lastSuccessMs = 0;
  diagnostics.record("logical_state_restored", {
    decisions: restored.size,
    savedAt: saved?.savedAt,
    cause: saved?.cause,
  });
}

function eligibleToolIds(calls: readonly JevToolCall[]): Set<string> {
  return new Set(calls.filter((call) => !call.pinned).map((call) => call.tool_use_id));
}

function hasUnscoredEligibleCall(calls: readonly JevToolCall[], state: RuntimeState): boolean {
  return calls.some((call) => !call.pinned && !state.decisions.has(call.tool_use_id));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function safeUrl(input: RequestInfo | URL): string {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

function requestMetrics(init?: RequestInit): { requestBytes?: number; questionCount?: number } {
  if (typeof init?.body !== "string") return {};
  const requestBytes = Buffer.byteLength(init.body, "utf8");
  try {
    const parsed = JSON.parse(init.body) as { questions?: unknown };
    const questionCount =
      parsed.questions && typeof parsed.questions === "object"
        ? Object.keys(parsed.questions as Record<string, unknown>).length
        : undefined;
    return { requestBytes, questionCount };
  } catch {
    return { requestBytes };
  }
}

function makeDiagnosticFetch(
  diagnostics: Diagnostics,
  config: Config,
  evaluationSignal: AbortSignal,
  state: RuntimeState,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const httpId = ++state.totalHttpRequests;
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Jev HTTP timed out after ${config.requestTimeoutMs}ms`));
    }, config.requestTimeoutMs);

    const abortEvaluation = (): void => {
      controller.abort(evaluationSignal.reason ?? new Error("Jev evaluation aborted"));
    };
    if (evaluationSignal.aborted) abortEvaluation();
    else evaluationSignal.addEventListener("abort", abortEvaluation, { once: true });

    const metrics = requestMetrics(init);
    diagnostics.record("http_start", {
      httpId,
      url: safeUrl(input),
      timeoutMs: config.requestTimeoutMs,
      ...metrics,
    });

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      const text = await response.text();
      const snapshot: HttpSnapshot = {
        httpId,
        status: response.status,
        durationMs: Date.now() - started,
        timedOut: false,
        ...metrics,
        responseBytes: Buffer.byteLength(text, "utf8"),
      };
      state.lastHttp = snapshot;
      diagnostics.record("http_end", {
        ...snapshot,
        totalHttpRequests: state.totalHttpRequests,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const snapshot: HttpSnapshot = {
        httpId,
        durationMs: Date.now() - started,
        timedOut,
        ...metrics,
        error: errorText(error),
      };
      state.lastHttp = snapshot;
      state.totalHttpErrors += 1;
      if (timedOut) state.totalHttpTimeouts += 1;
      diagnostics.record("http_error", {
        ...snapshot,
        totalHttpRequests: state.totalHttpRequests,
        totalHttpErrors: state.totalHttpErrors,
        totalHttpTimeouts: state.totalHttpTimeouts,
      });
      if (timedOut) throw new Error(`Jev HTTP timed out after ${config.requestTimeoutMs}ms`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      evaluationSignal.removeEventListener("abort", abortEvaluation);
    }
  }) as typeof fetch;
}

async function evaluate(
  projected: Projection,
  calls: readonly JevToolCall[],
  rawTokens: number,
  config: Config,
  sourceMessages: readonly AgentMessage[],
  diagnostics: Diagnostics,
  state: RuntimeState,
): Promise<Evaluation> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Jev evaluation timed out after ${config.evaluationTimeoutMs}ms`));
  }, config.evaluationTimeoutMs);

  try {
    const compaction = compactMessages(projected.messages, {
      apiKey: process.env.TYPESAFE_API_KEY,
      model: config.model,
      baseUrl: config.baseUrl,
      goal: config.goal ?? inferGoal(sourceMessages),
      keepThreshold: config.keepThreshold,
      preserveRecentMessages: config.preserveRecentMessages,
      protectedToolUseIds: projected.protectedToolCallIds,
      maxStateTokens: config.maxStateTokens,
      maxRequestTokens: config.maxRequestTokens,
      truncateHeadChars: config.truncateHeadChars,
      fetch: makeDiagnosticFetch(diagnostics, config, controller.signal, state),
    });
    const hardDeadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason ?? new Error("Jev evaluation aborted")),
        { once: true },
      );
    });
    const result = await Promise.race([compaction, hardDeadline]);
    return { result, calls: [...calls], rawTokens, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState): void {
  if (!state.enabled) {
    ctx.ui.setStatus(STATUS_KEY, "Jev off");
    return;
  }
  if (Date.now() < state.breakerUntilMs) {
    ctx.ui.setStatus(STATUS_KEY, "Jev bypass");
    return;
  }
  if (state.evaluating) {
    ctx.ui.setStatus(STATUS_KEY, "Jev…");
    return;
  }
  if (state.lastError) {
    ctx.ui.setStatus(STATUS_KEY, state.decisions.size > 0 ? "Jev committed · refresh failed" : "Jev fail-open");
    return;
  }
  const context = state.lastPiPercent === undefined ? "" : ` · ${state.lastPiPercent.toFixed(0)}% ctx`;
  if (state.active) {
    ctx.ui.setStatus(STATUS_KEY, `Jev armed${context}`);
    return;
  }
  if (state.decisions.size > 0) {
    const ratio = state.lastResult ? percent(reductionRatio(state.lastResult)) : "committed";
    ctx.ui.setStatus(STATUS_KEY, `Jev ${ratio}${context}`);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, `Jev idle${context}`);
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
}

function showEvaluationActivity(
  ctx: ExtensionContext,
  state: RuntimeState,
  eligible: number,
  rawTokens: number,
  piPercent: number | null,
  refreshReasons: readonly string[],
): void {
  const reason = refreshReasons.includes("forced")
    ? "forced refresh"
    : refreshReasons.includes("threshold_crossed")
      ? "context threshold crossed"
      : "newly eligible tools";
  ctx.ui.setStatus(STATUS_KEY, `Jev compacting… ${eligible} calls`);
  if (ctx.mode === "tui") {
    const contextLabel = piPercent === null ? "ctx unknown" : `ctx≈${piPercent.toFixed(1)}%`;
    ctx.ui.setWorkingMessage(
      `Jev compaction: scoring ${eligible} old tool call${eligible === 1 ? "" : "s"} · ${contextLabel} · ${reason}…`,
    );
  }
}

function clearEvaluationActivity(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
}

function countActions(result: CompactResult): Record<string, number> {
  const counts: Record<string, number> = { keep: 0, drop_result: 0, drop_call: 0, pinned: 0 };
  for (const decision of result.decisions) {
    if (decision.reason === "pinned") counts.pinned += 1;
    else counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  }
  return counts;
}

function breakerActive(state: RuntimeState): boolean {
  return Date.now() < state.breakerUntilMs;
}

interface LocalFileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function createLocalFileOps(): LocalFileOps {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractLocalFileOps(message: AgentMessage, fileOps: LocalFileOps): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    const path = args && typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    if (block.name === "read") fileOps.read.add(path);
    else if (block.name === "write") fileOps.written.add(path);
    else if (block.name === "edit") fileOps.edited.add(path);
  }
}

function rebuildCompactionFileOps(
  messages: readonly AgentMessage[],
  branchEntries: readonly unknown[],
): LocalFileOps {
  const fileOps = createLocalFileOps();

  // Preserve Pi's file metadata from the latest native compaction, then add
  // only operations that survive Jev pruning. This avoids importing Pi
  // internal helpers that are not part of the public extension API.
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i] as {
      type?: string;
      fromHook?: boolean;
      details?: { readFiles?: unknown; modifiedFiles?: unknown };
    };
    if (entry.type !== "compaction") continue;
    if (!entry.fromHook && entry.details) {
      if (Array.isArray(entry.details.readFiles)) {
        for (const path of entry.details.readFiles) {
          if (typeof path === "string") fileOps.read.add(path);
        }
      }
      if (Array.isArray(entry.details.modifiedFiles)) {
        for (const path of entry.details.modifiedFiles) {
          if (typeof path === "string") fileOps.edited.add(path);
        }
      }
    }
    break;
  }

  for (const message of messages) extractLocalFileOps(message, fileOps);
  return fileOps;
}

function sanitizeCompactionPreparation(
  preparation: {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    fileOps: LocalFileOps;
  },
  branchEntries: readonly unknown[],
  decisions: ReadonlyMap<string, CachedDecision>,
  truncateHeadChars: number,
): ApplyStats {
  const ids = decisionIds(decisions);
  const history = applyDecisionsDetailed(
    preparation.messagesToSummarize,
    decisions,
    ids,
    truncateHeadChars,
  );
  const prefix = applyDecisionsDetailed(
    preparation.turnPrefixMessages,
    decisions,
    ids,
    truncateHeadChars,
  );

  preparation.messagesToSummarize = history.messages;
  preparation.turnPrefixMessages = prefix.messages;
  preparation.fileOps = rebuildCompactionFileOps(
    [...history.messages, ...prefix.messages],
    branchEntries,
  );

  return {
    droppedCalls: history.stats.droppedCalls + prefix.stats.droppedCalls,
    droppedResults: history.stats.droppedResults + prefix.stats.droppedResults,
    truncatedResults: history.stats.truncatedResults + prefix.stats.truncatedResults,
    messagesBefore: history.stats.messagesBefore + prefix.stats.messagesBefore,
    messagesAfter: history.stats.messagesAfter + prefix.stats.messagesAfter,
  };
}

function logicalContextAtCompaction(
  ctx: ExtensionContext,
  state: RuntimeState,
  truncateHeadChars: number,
): { tokens: number; messages: number; percent: number | null } {
  const raw = ctx.sessionManager.buildSessionContext().messages;
  const logical = applyDecisionsDetailed(
    raw,
    state.decisions,
    decisionIds(state.decisions),
    truncateHeadChars,
  ).messages;
  const projection = projectMessages(logical);
  const tokens = rawTokenEstimate(projection.messages, ctx);
  const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
  return {
    tokens,
    messages: logical.length,
    percent: contextWindow && contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
  };
}

function failOpen(
  ctx: ExtensionContext,
  diagnostics: Diagnostics,
  state: RuntimeState,
  error: unknown,
  hookId?: number,
  retryDelayMs: number = DEFAULTS.retryDelayMs,
): void {
  state.lastError = errorText(error);
  state.retryAfterMs = Date.now() + retryDelayMs;
  state.consecutiveFailures += 1;
  state.failOpenCount += 1;
  state.insufficient = true;
  // Preserve already committed logical compaction. A failed refresh must not
  // resurrect tool calls/results that a previous successful pass deleted.

  diagnostics.record("fail_open", {
    hookId,
    error: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    failOpenCount: state.failOpenCount,
  });

  notify(ctx, `fast-jev-compaction: ${state.lastError}; keeping previously compacted logical history`, "warning");
}

async function evaluateAtTurnEnd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: Config,
  diagnostics: Diagnostics,
  state: RuntimeState,
  turnIndex: number,
): Promise<void> {
  if (!state.enabled) return;

  const rawMessages = ctx.sessionManager.buildSessionContext().messages;
  const rawIds = rawToolCallIds(rawMessages);

  if ([...state.decisions.keys()].some((id) => !rawIds.has(id))) {
    state.decisions = new Map([...state.decisions].filter(([id]) => rawIds.has(id)));
  }
  for (const id of [...state.deferredDropCalls.keys()]) {
    if (!rawIds.has(id)) state.deferredDropCalls.delete(id);
  }

  const logicalBefore = applyDecisionsDetailed(
    rawMessages,
    state.decisions,
    decisionIds(state.decisions),
    config.truncateHeadChars,
  ).messages;
  const projection = projectMessages(logicalBefore);
  const calls = collectToolCalls(
    projection.messages,
    config.preserveRecentMessages,
    projection.protectedToolCallIds,
  );
  const eligibleNow = eligibleToolIds(calls);
  const unscored = hasUnscoredEligibleCall(calls, state);

  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const logicalTokens = rawTokenEstimate(projection.messages, ctx);
  const logicalPercent =
    contextWindow && contextWindow > 0 ? (logicalTokens / contextWindow) * 100 : null;
  const effectivePercent = usage?.percent ?? logicalPercent;

  state.lastPiTokens = usage?.tokens ?? undefined;
  state.lastPiPercent = effectivePercent ?? undefined;
  state.lastContextWindow = contextWindow;
  state.lastLogicalTokens = logicalTokens;
  state.lastLogicalPercent = logicalPercent ?? undefined;
  state.lastLogicalToolCalls = calls.length;
  state.active = effectivePercent !== null && effectivePercent >= config.compactAtPercent;

  const forceRefresh = state.forceRefresh;
  const shouldEvaluate = shouldEvaluateAtTurnEnd(
    effectivePercent,
    config.compactAtPercent,
    forceRefresh,
    forceRefresh ? eligibleNow.size > 0 : unscored,
  );

  diagnostics.record("turn_evaluation_check", {
    turnIndex,
    effectivePercent: effectivePercent === null ? null : Number(effectivePercent.toFixed(2)),
    logicalPercent: logicalPercent === null ? null : Number(logicalPercent.toFixed(2)),
    triggerPercent: config.compactAtPercent,
    eligible: eligibleNow.size,
    unscored,
    forced: forceRefresh,
    shouldEvaluate,
    committed: state.decisions.size,
    deferredDropCalls: state.deferredDropCalls.size,
  });

  if (!shouldEvaluate) {
    updateStatus(ctx, state);
    return;
  }
  if (state.evaluating) {
    diagnostics.record("evaluation_skipped", { turnIndex, reason: "already_evaluating" });
    return;
  }
  if (Date.now() < state.retryAfterMs) {
    diagnostics.record("evaluation_skipped", {
      turnIndex,
      reason: "retry_backoff",
      retryRemainingMs: state.retryAfterMs - Date.now(),
    });
    return;
  }
  if (breakerActive(state)) {
    diagnostics.record("evaluation_skipped", {
      turnIndex,
      reason: "circuit_breaker",
      breakerRemainingMs: state.breakerUntilMs - Date.now(),
    });
    return;
  }

  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    state.lastError = "TYPESAFE_API_KEY is not configured";
    state.insufficient = true;
    if (!state.notifiedMissingKey) {
      notify(ctx, "fast-jev-compaction: TYPESAFE_API_KEY is not configured; Pi native compaction remains enabled", "warning");
      state.notifiedMissingKey = true;
    }
    diagnostics.record("evaluation_skipped", { turnIndex, reason: "missing_api_key" });
    updateStatus(ctx, state);
    return;
  }

  state.evaluating = true;
  state.forceRefresh = false;
  state.evaluationAttempts += 1;
  state.lastEvaluationEligible = eligibleNow.size;
  showEvaluationActivity(
    ctx,
    state,
    eligibleNow.size,
    logicalTokens,
    effectivePercent,
    forceRefresh ? ["forced"] : ["turn_end_threshold"],
  );
  diagnostics.record("evaluation_start", {
    turnIndex,
    mode: "active_result_only",
    eligible: eligibleNow.size,
    logicalCalls: calls.length,
    committedBefore: state.decisions.size,
    logicalTokens,
    effectivePercent: effectivePercent === null ? null : Number(effectivePercent.toFixed(2)),
    timeoutMs: config.evaluationTimeoutMs,
  });

  try {
    const evaluation = await evaluate(
      projection,
      calls,
      logicalTokens,
      config,
      logicalBefore,
      diagnostics,
      state,
    );
    const upstreamRatio = reductionRatio(evaluation.result);
    const activeMaps = activeDecisionMaps(evaluation.result, evaluation.calls);
    const effectiveRatio = activeReductionRatio(
      logicalBefore,
      activeMaps.committed,
      config.truncateHeadChars,
    );
    const accepted = acceptsReduction(effectiveRatio, config.minReductionRatio);
    const beforeMerge = new Map(state.decisions);

    if (accepted) {
      state.decisions = mergeMonotonicDecisions(beforeMerge, activeMaps.committed, rawIds);

      // Only the latest accepted evaluation controls which full deletions are
      // eligible for promotion at agent_end. Until then every such call remains
      // as a breadcrumb with at most its result truncated.
      for (const call of evaluation.calls) {
        if (!call.pinned) state.deferredDropCalls.delete(call.tool_use_id);
      }
      for (const [id, decision] of activeMaps.deferredDropCalls) {
        if (rawIds.has(id)) state.deferredDropCalls.set(id, decision);
      }

      persistLogicalState(pi, diagnostics, state, "turn_end_result_only");
    }

    state.lastResult = evaluation.result;
    state.lastEffectiveReduction = effectiveRatio;
    state.lastEvaluationMode = "active_result_only";
    state.lastError = undefined;
    state.retryAfterMs = 0;
    state.insufficient = !accepted;
    state.consecutiveFailures = 0;
    state.breakerUntilMs = 0;
    state.lastSuccessMs = accepted ? Date.now() : state.lastSuccessMs;
    state.lastEvaluationMs = evaluation.durationMs;
    state.lastEvaluationRequests = evaluation.result.stats.requests;
    state.evaluationSuccesses += 1;

    if (accepted) {
      const applied = applyDecisionsDetailed(
        rawMessages,
        state.decisions,
        decisionIds(state.decisions),
        config.truncateHeadChars,
      );
      const postProjection = projectMessages(applied.messages);
      const postTokens = rawTokenEstimate(postProjection.messages, ctx);
      state.lastLogicalTokens = postTokens;
      state.lastLogicalPercent =
        contextWindow && contextWindow > 0 ? (postTokens / contextWindow) * 100 : undefined;
      state.lastApply = applied.stats;
    }

    const downgradedDropCalls = [...activeMaps.deferredDropCalls].length;
    diagnostics.record("evaluation_success", {
      turnIndex,
      mode: "active_result_only",
      durationMs: evaluation.durationMs,
      upstreamReduction: Number(upstreamRatio.toFixed(4)),
      effectiveReduction: Number(effectiveRatio.toFixed(4)),
      requests: evaluation.result.stats.requests,
      stateTokens: evaluation.result.stats.stateTokens,
      stateStage: evaluation.result.stats.stateStage,
      proposedDecisions: activeMaps.committed.size,
      downgradedDropCalls,
      committedBefore: beforeMerge.size,
      committedAfter: state.decisions.size,
      deferredDropCalls: state.deferredDropCalls.size,
      actions: countActions(evaluation.result),
      accepted,
    });
  } catch (error) {
    failOpen(ctx, diagnostics, state, error, undefined, config.retryDelayMs);
    if (state.consecutiveFailures >= config.circuitBreakerFailures) {
      state.breakerUntilMs = Date.now() + config.circuitBreakerMs;
      diagnostics.record("circuit_breaker_open", {
        turnIndex,
        failures: state.consecutiveFailures,
        breakerMs: config.circuitBreakerMs,
      });
    }
  } finally {
    state.evaluating = false;
    clearEvaluationActivity(ctx);
    updateStatus(ctx, state);
  }
}

export default function fastJevCompaction(pi: ExtensionAPI): void {
  const config = resolveConfig();
  const diagnostics = new Diagnostics({
    enabled: config.diagnostics,
    file: config.diagnosticsFile,
    stderr: config.diagnosticsStderr,
  });
  const state: RuntimeState = {
    enabled: true,
    active: false,
    forceRefresh: false,
    evaluating: false,
    decisions: new Map(),
    insufficient: false,
    notifiedMissingKey: false,
    retryAfterMs: 0,
    consecutiveFailures: 0,
    breakerUntilMs: 0,
    lastSuccessMs: 0,
    restoredDecisionCount: 0,
    contextHookCount: 0,
    failOpenCount: 0,
    thresholdCancelledCount: 0,
    thresholdPassedCount: 0,
    evaluationAttempts: 0,
    evaluationSuccesses: 0,
    totalHttpRequests: 0,
    totalHttpErrors: 0,
    totalHttpTimeouts: 0,
    providerRequestCount: 0,
    deferredDropCalls: new Map(),
  };

  diagnostics.record("extension_loaded", {
    version: "0.4.0",
    compactAtPercent: config.compactAtPercent,
    nativeFallbackPercent: config.nativeFallbackPercent,
    requestTimeoutMs: config.requestTimeoutMs,
    evaluationTimeoutMs: config.evaluationTimeoutMs,
    circuitBreakerFailures: config.circuitBreakerFailures,
    circuitBreakerMs: config.circuitBreakerMs,
    diagnosticsFile: diagnostics.file,
  });

  pi.on("session_start", (event, ctx) => {
    restoreLogicalState(ctx, diagnostics, state);
    diagnostics.record("session_start", { reason: event.reason, restored: state.decisions.size });
    updateStatus(ctx, state);
  });

  pi.on("context", async (event, ctx) => {
    const hookId = ++state.contextHookCount;
    const hookStarted = Date.now();
    state.lastContextHookId = hookId;
    state.lastContextOutcome = "entered";

    if (!state.enabled) {
      state.lastContextOutcome = "disabled";
      diagnostics.record("context_bypass", { hookId, reason: "disabled" });
      return;
    }

    try {
      const rawIds = rawToolCallIds(event.messages);
      if ([...state.decisions.keys()].some((id) => !rawIds.has(id))) {
        const before = state.decisions.size;
        state.decisions = new Map([...state.decisions].filter(([id]) => rawIds.has(id)));
        diagnostics.record("logical_state_reconciled", {
          hookId,
          before,
          after: state.decisions.size,
          removed: before - state.decisions.size,
        });
      }
      for (const id of [...state.deferredDropCalls.keys()]) {
        if (!rawIds.has(id)) state.deferredDropCalls.delete(id);
      }

      const applied = applyDecisionsDetailed(
        event.messages,
        state.decisions,
        decisionIds(state.decisions),
        config.truncateHeadChars,
      );
      const logicalMessages = applied.messages;
      const grossProjection = projectMessages(event.messages);
      const logicalProjection = projectMessages(logicalMessages);
      const logicalCalls = collectToolCalls(
        logicalProjection.messages,
        config.preserveRecentMessages,
        logicalProjection.protectedToolCallIds,
      );

      const grossTokens = rawTokenEstimate(grossProjection.messages, ctx);
      const logicalTokens = rawTokenEstimate(logicalProjection.messages, ctx);
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
      const grossPercent =
        contextWindow && contextWindow > 0 ? (grossTokens / contextWindow) * 100 : undefined;
      const logicalPercent =
        contextWindow && contextWindow > 0 ? (logicalTokens / contextWindow) * 100 : undefined;
      const effectivePercent = usage?.percent ?? logicalPercent ?? null;

      state.lastRawTokens = grossTokens;
      state.lastRawPercent = grossPercent;
      state.lastLogicalTokens = logicalTokens;
      state.lastLogicalPercent = logicalPercent;
      state.lastPiTokens = usage?.tokens ?? undefined;
      state.lastPiPercent = effectivePercent ?? undefined;
      state.lastContextWindow = contextWindow;
      state.lastGrossToolCalls = rawIds.size;
      state.lastLogicalToolCalls = logicalCalls.length;
      state.lastApply = applied.stats;
      state.active =
        effectivePercent !== null && effectivePercent >= config.compactAtPercent;

      state.lastContextOutcome =
        state.decisions.size > 0
          ? state.active
            ? "applied_committed_at_threshold"
            : "applied_committed"
          : state.active
            ? "armed_no_decisions"
            : "idle";

      diagnostics.record("context_apply", {
        hookId,
        outcome: state.lastContextOutcome,
        rawMessages: event.messages.length,
        logicalMessages: logicalMessages.length,
        grossToolCalls: rawIds.size,
        logicalCalls: logicalCalls.length,
        committed: state.decisions.size,
        deferredDropCalls: state.deferredDropCalls.size,
        grossTokens,
        logicalTokens,
        contextWindow,
        grossPercent: grossPercent === undefined ? null : Number(grossPercent.toFixed(2)),
        logicalPercent: logicalPercent === undefined ? null : Number(logicalPercent.toFixed(2)),
        piTokens: usage?.tokens ?? null,
        piPercent: effectivePercent === null ? null : Number(effectivePercent.toFixed(2)),
        compactAtPercent: config.compactAtPercent,
        ...applied.stats,
        durationMs: Date.now() - hookStarted,
      });
      updateStatus(ctx, state);

      if (state.decisions.size > 0) return { messages: logicalMessages };
      return;
    } catch (error) {
      failOpen(ctx, diagnostics, state, error, hookId, config.retryDelayMs);
      state.lastContextOutcome = "context_apply_failed";
      diagnostics.record("context_exit", {
        hookId,
        outcome: state.lastContextOutcome,
        durationMs: Date.now() - hookStarted,
        error: errorText(error),
      });
      updateStatus(ctx, state);
      return;
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    let sanitized: ApplyStats | undefined;
    if (state.enabled && state.decisions.size > 0) {
      sanitized = sanitizeCompactionPreparation(
        event.preparation,
        state.decisions,
        config.truncateHeadChars,
      );
      diagnostics.record("native_compaction_sanitized", {
        reason: event.reason,
        committed: state.decisions.size,
        ...sanitized,
      });
    }

    if (!state.enabled || event.reason !== "threshold") {
      diagnostics.record("before_compact", {
        reason: event.reason,
        outcome: state.enabled && sanitized ? "pass_sanitized" : "pass",
        enabled: state.enabled,
        willRetry: event.willRetry,
        sanitized,
      });
      return;
    }

    state.active = true;
    state.forceRefresh = true;

    const hasKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
    const logical = logicalContextAtCompaction(
      event.branchEntries,
      ctx,
      state,
      config.truncateHeadChars,
    );
    const nativeLimit =
      contextWindow && contextWindow > 0
        ? Math.max(0, contextWindow - event.preparation.settings.reserveTokens)
        : undefined;
    const hasHeadroom = hasNativeHeadroom(
      logical.tokens,
      contextWindow,
      event.preparation.settings.reserveTokens,
    );
    const healthy =
      hasKey &&
      !breakerActive(state) &&
      !state.lastError &&
      !state.insufficient &&
      state.decisions.size > 0 &&
      hasHeadroom;

    if (!healthy) {
      state.thresholdPassedCount += 1;
      diagnostics.record("before_compact", {
        reason: event.reason,
        outcome: "pass_native_sanitized",
        willRetry: event.willRetry,
        hasKey,
        breaker: breakerActive(state),
        lastError: state.lastError,
        insufficient: state.insufficient,
        committed: state.decisions.size,
        logicalTokens: logical.tokens,
        logicalMessages: logical.messages,
        contextWindow,
        nativeLimit,
        hasHeadroom,
        sanitized,
        thresholdPassedCount: state.thresholdPassedCount,
      });
      updateStatus(ctx, state);
      return;
    }

    state.thresholdCancelledCount += 1;
    diagnostics.record("before_compact", {
      reason: event.reason,
      outcome: "cancel_for_jev_headroom",
      willRetry: event.willRetry,
      committed: state.decisions.size,
      logicalTokens: logical.tokens,
      logicalMessages: logical.messages,
      contextWindow,
      nativeLimit,
      hasHeadroom,
      sanitized,
      thresholdCancelledCount: state.thresholdCancelledCount,
    });
    updateStatus(ctx, state);
    return { cancel: true };
  });

  pi.on("session_compact", (event, ctx) => {
    // Do not clear decisions yet: Pi keeps a raw recent tail after compaction.
    // Decisions for calls still in that tail must continue to apply. The next
    // context hook reconciles away decisions whose tool IDs were summarized.
    state.forceRefresh = false;
    state.active = false;
    state.insufficient = false;
    state.lastError = undefined;
    state.lastResult = undefined;
    state.lastSuccessMs = 0;
    state.restoredDecisionCount = 0;
    persistLogicalState(pi, diagnostics, state, "native_compaction_tail");
    diagnostics.record("session_compact", {
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
      retainedDecisionsUntilReconcile: state.decisions.size,
    });
    updateStatus(ctx, state);
  });

  pi.on("session_compact_failed", (event, ctx) => {
    diagnostics.record("session_compact_failed", {
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
      aborted: event.aborted,
      error: event.errorMessage,
    });
    if (!event.aborted && event.errorMessage) state.lastError = `native compaction: ${event.errorMessage}`;
    updateStatus(ctx, state);
  });

  pi.on("session_tree", (event, ctx) => {
    restoreLogicalState(ctx, diagnostics, state);
    diagnostics.record("session_tree", {
      oldLeafId: event.oldLeafId,
      newLeafId: event.newLeafId,
      fromExtension: event.fromExtension,
      restored: state.decisions.size,
    });
    updateStatus(ctx, state);
  });

  pi.on("session_shutdown", (event) => {
    diagnostics.record("session_shutdown", { reason: event.reason });
  });

  const showStatus = (ctx: ExtensionContext): void => {
    const result = state.lastResult;
    const breakerRemaining = Math.max(0, state.breakerUntilMs - Date.now());
    const rawWindow = state.lastContextWindow && state.lastContextWindow > 0
      ? ` / ${formatTokens(state.lastContextWindow)}`
      : "";
    const piContext = state.lastPiTokens !== undefined
      ? `${formatTokens(state.lastPiTokens)}${rawWindow} (${(state.lastPiPercent ?? 0).toFixed(1)}%)`
      : `unknown${rawWindow}`;
    const lastApply = state.lastApply
      ? `dropped calls=${state.lastApply.droppedCalls}, dropped results=${state.lastApply.droppedResults}, truncated results=${state.lastApply.truncatedResults}`
      : "n/a";
    const committedDropCalls = [...state.decisions.values()].filter((decision) => decision.action === "drop_call").length;
    const committedDropResults = [...state.decisions.values()].filter((decision) => decision.action === "drop_result").length;
    const committedKeeps = [...state.decisions.values()].filter((decision) => decision.action === "keep").length;
    const logicalContext = state.lastLogicalTokens !== undefined
      ? `${formatTokens(state.lastLogicalTokens)}${rawWindow} (${(state.lastLogicalPercent ?? 0).toFixed(1)}%)`
      : `unknown${rawWindow}`;
    const lines = [
      `fast-jev-compaction: enabled=${state.enabled} · at-threshold=${state.active} · evaluating=${state.evaluating}`,
      `context: Pi≈${piContext} · Jev trigger=${config.compactAtPercent}%`,
      `logical history≈${logicalContext} · calls=${state.lastLogicalToolCalls ?? "n/a"}; this is what the model and next Jev pass see`,
      `persisted Pi transcript≈${formatTokens(state.lastRawTokens ?? 0)}${rawWindow} (${(state.lastRawPercent ?? 0).toFixed(1)}%) · calls=${state.lastGrossToolCalls ?? "n/a"}; diagnostic only`,
      `committed decisions: ${state.decisions.size} total · drop_call=${committedDropCalls} · drop_result=${committedDropResults} · keep=${committedKeeps} · restored=${state.restoredDecisionCount}`,
      `evaluations: ${state.evaluationSuccesses}/${state.evaluationAttempts} successful · Jev HTTP requests=${state.totalHttpRequests} total${state.lastEvaluationRequests !== undefined ? ` (last pass=${state.lastEvaluationRequests})` : ""}`,
      result
        ? `last pass: incremental reduction=${percent(reductionRatio(result))} · eligible=${state.lastEvaluationEligible ?? "n/a"} · ${state.lastEvaluationMs ?? "n/a"}ms · Jev state≈${formatTokens(result.stats.stateTokens)} (${result.stats.stateStage || "n/a"})`
        : "last pass: n/a",
      `last apply: ${lastApply}`,
      state.lastHttp
        ? `last HTTP: ${state.lastHttp.status ?? "error"} · ${state.lastHttp.durationMs}ms${state.lastHttp.timedOut ? " · timeout" : ""}`
        : "last HTTP: n/a",
      `HTTP errors=${state.totalHttpErrors} · timeouts=${state.totalHttpTimeouts} · failed refreshes=${state.failOpenCount}`,
      `pipeline: context#${state.lastContextHookId ?? "n/a"}=${state.lastContextOutcome ?? "n/a"} · provider requests=${state.providerRequestCount}${state.lastProviderStatus !== undefined ? ` · last provider=${state.lastProviderStatus}/${state.lastProviderDurationMs ?? "n/a"}ms` : ""}`,
      breakerRemaining > 0 ? `circuit breaker: open for ${breakerRemaining}ms` : "circuit breaker: closed",
      state.lastError ? `error: ${state.lastError}` : "error: none",
      `diagnostics: ${diagnostics.file}`,
    ];
    notify(ctx, lines.join("\n"));
  };

  pi.on("before_provider_request", (_event) => {
    const requestId = ++state.providerRequestCount;
    state.lastProviderRequestMs = Date.now();
    diagnostics.record("provider_request_start", {
      requestId,
      contextHookId: state.lastContextHookId,
      contextOutcome: state.lastContextOutcome,
      jevActive: state.active,
      jevError: state.lastError,
      committed: state.decisions.size,
      lastApply: state.lastApply,
    });
  });

  pi.on("after_provider_response", (event) => {
    const durationMs = state.lastProviderRequestMs ? Date.now() - state.lastProviderRequestMs : undefined;
    state.lastProviderDurationMs = durationMs;
    state.lastProviderStatus = event.status;
    diagnostics.record("provider_response", {
      requestId: state.providerRequestCount,
      status: event.status,
      durationMs,
      contextHookId: state.lastContextHookId,
      contextOutcome: state.lastContextOutcome,
    });
  });

  pi.on("turn_start", (event) => {
    diagnostics.record("turn_start", {
      turnIndex: event.turnIndex,
      contextHookId: state.lastContextHookId,
    });
  });

  pi.on("turn_end", (event) => {
    const message = event.message as unknown as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      stopReason?: string;
      rawStopReason?: string;
      usage?: { input?: number; output?: number; totalTokens?: number; cacheRead?: number };
    };
    const blocks = Array.isArray(message.content) ? message.content : [];
    const contentTypes = blocks.map((block) => block.type ?? "unknown");
    const toolCalls = contentTypes.filter((type) => type === "toolCall").length;
    const textChars = blocks.reduce(
      (sum, block) => sum + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0),
      0,
    );
    diagnostics.record("turn_end", {
      turnIndex: event.turnIndex,
      role: message.role,
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      contentTypes,
      toolCalls,
      textChars,
      toolResults: event.toolResults?.length ?? 0,
      usage: message.usage,
      contextHookId: state.lastContextHookId,
      contextOutcome: state.lastContextOutcome,
      providerStatus: state.lastProviderStatus,
      providerDurationMs: state.lastProviderDurationMs,
    });
  });

  pi.on("agent_settled", () => {
    state.settledGeneration += 1;
    diagnostics.record("agent_settled", {
      generation: state.settledGeneration,
      contextHookId: state.lastContextHookId,
      contextOutcome: state.lastContextOutcome,
    });
  });

  pi.registerCommand("jev-status", {
    description: "Show fast-jev-compaction state, counters, and last pass",
    handler: async (_args, ctx) => showStatus(ctx),
  });

  pi.registerCommand("jev-stats", {
    description: "Alias for /jev-status",
    handler: async (_args, ctx) => showStatus(ctx),
  });

  pi.registerCommand("jev-diagnostics", {
    description: "Show recent Jev diagnostic events and log file path",
    handler: async (args, ctx) => {
      const requested = Number(args.trim());
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(20, Math.floor(requested)) : 8;
      const lines = diagnostics.recent(limit).map(summarizeDiagnostic);
      notify(
        ctx,
        `fast-jev-compaction diagnostics\nlog: ${diagnostics.file}\n${lines.length ? lines.join("\n") : "(no events yet)"}`,
      );
    },
  });

  pi.registerCommand("jev-diagnostics-clear", {
    description: "Clear the Jev diagnostic log and in-memory ring buffer",
    handler: async (_args, ctx) => {
      diagnostics.clear();
      diagnostics.record("diagnostics_cleared");
      notify(ctx, `fast-jev-compaction: diagnostics cleared (${diagnostics.file})`);
    },
  });

  pi.registerCommand("jev-refresh", {
    description: "Force Jev to re-evaluate old tool context on the next model call",
    handler: async (_args, ctx) => {
      state.enabled = true;
      state.active = true;
      state.forceRefresh = true;
      state.insufficient = false;
      state.lastError = undefined;
      state.breakerUntilMs = 0;
      state.consecutiveFailures = 0;
      diagnostics.record("manual_refresh_armed");
      updateStatus(ctx, state);
      notify(ctx, "fast-jev-compaction: refresh armed for the next model call");
    },
  });

  pi.registerCommand("jev-on", {
    description: "Enable Jev context pruning for this session",
    handler: async (_args, ctx) => {
      state.enabled = true;
      state.active = true;
      state.forceRefresh = true;
      state.breakerUntilMs = 0;
      state.consecutiveFailures = 0;
      diagnostics.record("enabled");
      updateStatus(ctx, state);
      notify(ctx, "fast-jev-compaction: enabled for this session");
    },
  });

  pi.registerCommand("jev-off", {
    description: "Disable Jev context pruning for this session",
    handler: async (_args, ctx) => {
      state.enabled = false;
      diagnostics.record("disabled");
      updateStatus(ctx, state);
      notify(ctx, "fast-jev-compaction: disabled for this session");
    },
  });
}
