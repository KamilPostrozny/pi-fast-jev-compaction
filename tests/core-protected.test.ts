import test from "node:test";
import assert from "node:assert/strict";
import { collectToolCalls, type Message } from "../extensions/fast-jev-core.ts";

function assistantCall(id: string): Message {
  return {
    role: "assistant",
    text: "",
    toolUses: [{ tool_use_id: id, tool: "screenshot", input: { path: "/tmp/x.png" } }],
  };
}

function result(id: string): Message {
  return {
    role: "user",
    text: "",
    toolUses: [],
    toolResults: [{ tool_use_id: id, text: "[image-bearing tool result protected from Jev pruning]" }],
  };
}

test("explicitly protected tool calls stay visible but are pinned from pruning", () => {
  const messages: Message[] = [
    { role: "user", text: "inspect this", toolUses: [] },
    assistantCall("image-1"),
    result("image-1"),
    { role: "assistant", text: "done", toolUses: [] },
  ];
  const calls = collectToolCalls(messages, 0, new Set(["image-1"]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool_use_id, "image-1");
  assert.equal(calls[0]?.pinned, true);
});
