/*
 * OpenRouter-backed JevAsker: reuses the same OPENROUTER_API_KEY that pi's
 * OpenRouter model provider uses, so compaction needs a single key.
 *
 * The SystemOne endpoint takes {model, state, questions} and returns
 * {answers: {name: {noul}}} directly. OpenRouter is a standard
 * OpenAI-compatible chat API, so we serialize the state and questions into a
 * chat prompt, ask for strict JSON, and validate every answer fail-closed
 * (an invalid answer throws, exactly like parseJevResponse does upstream).
 */

import {
  type JevAsker,
  type JevClientOptions,
  type JevQuestions,
  type JevResponse,
  type JevState,
  STATE_CONTEXT,
} from "./fast-jev-core.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DEFAULT_MODEL = "openrouter/free";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const RESPONSE_CONTRACT =
  'For each question, answer "noul": your estimate of the probability that the statement is true, a number between 0 and 1 (inclusive). ' +
  'Respond with ONLY a JSON object of this exact shape, no markdown fences, no commentary:\n' +
  '{"answers":{"<question name>":{"noul":<number>}}}';

function questionPayload(questions: JevQuestions): Record<string, unknown> {
  const normalized: Record<string, { type: string; instructions: string }> = {};
  for (const [name, question] of Object.entries(questions)) {
    normalized[name] = { type: question.type, instructions: question.instructions };
  }
  return normalized;
}

function extractContent(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("OpenRouter returned malformed JSON");
  }
  const completion = parsed as ChatCompletionResponse;
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("OpenRouter response is missing message content");
  }
  return content;
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function parseAnswers(content: string): JevResponse["answers"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    throw new Error("OpenRouter answer is not valid JSON");
  }
  const answers = (parsed as { answers?: unknown })?.answers;
  if (answers === null || typeof answers !== "object") {
    throw new Error("OpenRouter answer is missing answers");
  }
  return answers as JevResponse["answers"];
}

function validatedNoul(answer: unknown, name: string): number {
  const noul = (answer as { noul?: unknown })?.noul;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw new Error(`Invalid OpenRouter answer for ${name}`);
  }
  return noul;
}

export class OpenRouterJevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.model = options.model ?? OPENROUTER_DEFAULT_MODEL;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
    const userContent = JSON.stringify({
      state: typeof state === "string" ? JSON.parse(state) : state,
      questions: questionPayload(questions),
    });
    const response = await this.fetcher(this.baseUrl ?? OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: `${STATE_CONTEXT}\n\n${RESPONSE_CONTRACT}` },
          { role: "user", content: userContent },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 200)}`);
    const content = extractContent(text);
    const answers = parseAnswers(content);
    const validated: Record<string, { noul: number }> = {};
    for (const [name] of Object.entries(questions)) {
      validated[name] = { noul: validatedNoul(answers[name], name) };
    }
    const completion = JSON.parse(text) as ChatCompletionResponse;
    return {
      model: this.model,
      answers: validated,
      usage: {
        input_tokens: completion.usage?.prompt_tokens,
        output_tokens: completion.usage?.completion_tokens,
      },
    };
  }
}
