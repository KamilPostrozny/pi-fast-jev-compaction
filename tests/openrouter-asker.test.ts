import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenRouterJevClient,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_URL,
} from "../extensions/openrouter-asker.ts";

const STATE = {
  agentName: "test-agent",
  systemPrompt: "Be helpful.",
  goal: "Finish the work",
  conversation: [{ role: "user", content: "hello" }],
};
const QUESTIONS = {
  call_1: { type: "noul", instructions: "Rate tool call 1." },
  result_1: { type: "noul", instructions: "Rate tool result 1." },
};

function chatResponse(content: string, usage = { prompt_tokens: 11, completion_tokens: 7 }): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage,
    }),
    { status: 200 },
  );
}

test("openrouter asker posts to OpenRouter chat completions with bearer key and parses plain JSON", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch: typeof fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return chatResponse(
      JSON.stringify({ answers: { call_1: { noul: 0.25 }, result_1: { noul: 0.9 } } }),
    );
  };
  const client = new OpenRouterJevClient({ apiKey: "test-key", fetch: mockFetch });
  const response = await client.ask(STATE, QUESTIONS);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENROUTER_URL);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, OPENROUTER_DEFAULT_MODEL);
  assert.equal((calls[0].init.headers as Record<string, string>)["authorization"], "Bearer test-key");
  assert.deepEqual(response.answers, { call_1: { noul: 0.25 }, result_1: { noul: 0.9 } });
  assert.deepEqual(response.usage, { input_tokens: 11, output_tokens: 7 });
  assert.match(body.messages[0].content, /noul/);
  const userPayload = JSON.parse(body.messages[1].content);
  assert.deepEqual(userPayload.questions.call_1, { type: "noul", instructions: "Rate tool call 1." });
});

test("openrouter asker strips markdown fences and ignores extra answer keys", async () => {
  const mockFetch: typeof fetch = async () =>
    chatResponse('```json\n{"answers":{"call_1":{"noul":0.5},"result_1":{"noul":1},"extra":{"noul":1}}}\n```');
  const client = new OpenRouterJevClient({ apiKey: "test-key", fetch: mockFetch });
  const response = await client.ask(STATE, QUESTIONS);
  assert.deepEqual(Object.keys(response.answers), ["call_1", "result_1"]);
  assert.equal(response.answers.result_1.noul, 1);
});

test("openrouter asker throws fail-closed on malformed, missing, or invalid answers", async () => {
  const client = (content: string | null) =>
    new OpenRouterJevClient({
      apiKey: "test-key",
      fetch: async () => chatResponse(content ?? ""),
    });
  await assert.rejects(
    () => client('{"answers":{"call_1":{"noul":1.5},"result_1":{"noul":0}}}').ask(STATE, QUESTIONS),
    /Invalid OpenRouter answer for call_1/,
  );
  await assert.rejects(
    () => client('{"answers":{"call_1":{"noul":0}},"oops"}').ask(STATE, QUESTIONS),
    /not valid JSON/,
  );
  await assert.rejects(
    () => client(null).ask(STATE, QUESTIONS),
    /missing message content/,
  );
  await assert.rejects(
    () => client('{"answers":{"result_1":{"noul":0}}}').ask(STATE, QUESTIONS),
    /Invalid OpenRouter answer for call_1/,
  );
});

test("openrouter asker surfaces HTTP errors and refuses to run without a key", async () => {
  const failing: typeof fetch = async () =>
    new Response('{"error":"nope"}', { status: 401 });
  const client = new OpenRouterJevClient({ apiKey: "test-key", fetch: failing });
  await assert.rejects(() => client.ask(STATE, QUESTIONS), /failed \(401\)/);

  const missing = new OpenRouterJevClient({ apiKey: "", fetch: failing });
  await assert.rejects(() => missing.ask(STATE, QUESTIONS), /OPENROUTER_API_KEY is not configured/);
});