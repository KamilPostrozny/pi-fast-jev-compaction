import test from "node:test";
import assert from "node:assert/strict";
import { compactMessages, type Message } from "../extensions/fast-jev-core.ts";

const messages: Message[] = [{ role: "user", text: "Fix the test", toolUses: [] }];
for (let i = 1; i <= 3; i++) {
  messages.push(
    { role: "assistant", text: "", toolUses: [{ tool_use_id: `call-${i}`, tool: "read", input: { path: `source-${i}.ts` } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `call-${i}`, text: "SECRET_RESULT_SENTINEL ".repeat(100) }] },
  );
}

test("Jev probabilities map to call/result decisions correctly at the unchanged 0.5 threshold", async () => {
  let captured: any;
  const result = await compactMessages(messages, {
    apiKey: "test", preserveRecentMessages: 0,
    fetch: (async (_url, init) => {
      captured = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ answers: {
        call_t1: { noul: 0.1 }, result_t1: { noul: 0.9 },
        call_t2: { noul: 0.5 }, result_t2: { noul: 0.49 },
        call_t3: { noul: 0.1 }, result_t3: { noul: 0.2 },
      } }));
    }) as typeof fetch,
  });
  assert.deepEqual(result.decisions.map(d => [d.action, d.keepCall, d.keepResult]), [
    ["keep", 0.1, 0.9], ["drop_result", 0.5, 0.49], ["drop_call", 0.1, 0.2],
  ]);
  assert.match(captured.questions.result_t1.instructions, /re-running the tool would not do/);
  assert.ok(JSON.stringify(captured.state).includes("chars (omitted)"));
  assert.ok(!JSON.stringify(captured.state).includes("SECRET_RESULT_SENTINEL"), "upstream state omits output contents");
});

for (const invalid of [-0.1, 1.1, "0.9", null, {}, true]) {
  test(`invalid noul answer fails open rather than turning into a deletion: ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(compactMessages(messages, {
      apiKey: "test", preserveRecentMessages: 0,
      fetch: (async () => new Response(JSON.stringify({ answers: {
        call_t1: typeof invalid === "object" || typeof invalid === "boolean" ? invalid : { noul: invalid },
        result_t1: { noul: 0 },
      } }))) as typeof fetch,
    }), /Invalid Jev answer/);
  });
}
