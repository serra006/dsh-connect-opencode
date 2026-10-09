// End-to-end bridge test WITHOUT spawning opencode: run a mock server speaking opencode's
// protocol, point the real Backend + shim at it, and exercise the full OpenAI surface.
import http from "node:http";
import assert from "node:assert/strict";
import { Backend } from "../lib/opencode.js";
import { createShim } from "../lib/shim.js";
import { freeModels, modelEntry } from "../lib/catalog.js";
import { decode } from "../lib/protocol.js";

// --- mock opencode server ---------------------------------------------------------------
const PROVIDER_CATALOG = {
  all: [{
    id: "opencode",
    models: {
      "free-chat": {
        name: "Free Chat", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200000, input: 128000, output: 8192 },
        capabilities: { output: { text: true }, input: { image: false }, toolcall: false, reasoning: false },
        status: "active",
      },
      "free-tool": {
        name: "Free Tool", cost: { input: 0, output: 0 },
        limit: { context: 128000, output: 4096 },
        capabilities: { output: { text: true }, input: { image: true }, toolcall: true, reasoning: true },
        status: "active",
        variants: { low: "v-low", high: "v-high" },
      },
      "paid-model": { name: "Paid", cost: { input: 3, output: 15 }, capabilities: { output: { text: true } }, status: "active" },
      "no-text": { name: "No Text", cost: { input: 0, output: 0 }, capabilities: { output: { text: false } }, status: "active" },
      "old-model": { name: "Old", cost: { input: 0, output: 0 }, capabilities: { output: { text: true } }, status: "deprecated" },
    },
  }, {
    // A custom user-configured provider (like the AMD gateway) with no cost fields at all —
    // undefined cost must count as free.
    id: "test",
    models: {
      "DeepSeek-V4-Flash": { name: "dp", capabilities: { output: { text: true }, toolcall: true } },
    },
  }],
};

let messageId = 0;
let lastMessageBody;
const mock = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  const expect = "Basic " + Buffer.from("opencode:testpw").toString("base64");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (auth !== expect) return send(401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/global/health") return send(200, { healthy: true, version: "1.18.32" });
  if (url.pathname === "/provider") return send(200, PROVIDER_CATALOG);
  if (url.pathname === "/session" && req.method === "POST") { let b = ""; req.on("data", c => b += c); req.on("end", () => send(200, { id: "ses_" + (++messageId), title: "x" })); return; }
  // /session/:id/message — reply by agent (bridge -> structured envelope; chat -> text part)
  if (/\/session\/[^/]+\/message$/.test(url.pathname) && req.method === "POST") {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const body = JSON.parse(b);
      lastMessageBody = body;
      const tokens = { input: 11, output: 7, reasoning: 2, cache: { read: 1 } };
      if (body.agent === "buddy-chat") return send(200, { info: { tokens, role: "assistant" }, parts: [{ type: "text", text: "hello from chat" }] });
      // bridge: echo a structured envelope. If the prompt lists tools, propose one call.
      const envelope = { content: "thinking", calls: [] };
      send(200, { info: { tokens, role: "assistant", structured: envelope }, parts: [] });
    });
    return;
  }
  if (/\/session\/[^/]+\/abort$/.test(url.pathname) && req.method === "POST") return send(200, {});
  if (/\/session\/[^/]+$/.test(url.pathname) && req.method === "DELETE") return send(200, {});
  send(404, { error: "no route" });
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;
const backend = new Backend(base, "testpw");

// --- 1) discovery -----------------------------------------------------------------------
const free = freeModels(await backend.providers());
assert.deepEqual(free.map((m) => m.id), ["opencode/free-chat", "opencode/free-tool", "test/DeepSeek-V4-Flash"], "cost-0 text models from EVERY provider (built-in + custom)");
const entries = free.map(modelEntry);
const entryById = Object.fromEntries(entries.map((e) => [e.id, e]));
const custom = free.find((m) => m.id === "test/DeepSeek-V4-Flash");
assert.equal(custom.providerID, "test");
assert.equal(custom.modelID, "DeepSeek-V4-Flash");
assert.equal(entryById["test/DeepSeek-V4-Flash"].chatOnly, false, "toolcall:true -> bridge path");
assert.equal(entryById["test/DeepSeek-V4-Flash"].contextWindow, undefined, "no limit -> undefined ctx (adapter falls back)");
assert.equal(entryById["opencode/free-chat"].chatOnly, true);
assert.equal(entryById["opencode/free-tool"].chatOnly, false);
assert.deepEqual(entryById["opencode/free-tool"].inputModalities, ["text", "image"]);
assert.equal(entryById["opencode/free-tool"].contextWindow, 128000); // prefers limit.input
console.log("1) discovery OK:", entries.map((e) => e.displayName));

// --- 2) health + catalog via shim (non-stream) ------------------------------------------
let catalog = entries;
const shim = createShim({ getModels: () => catalog, complete: (r, s) => backend.complete(r, s) });
await shim.ready;
const token = shim.token();
async function callShim(pathname, body, stream) {
  const res = await fetch(shim.baseUrl() + pathname, { method: pathname === "/v1/models" ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: stream ? text : JSON.parse(text), headers: Object.fromEntries(res.headers) };
}

const models = await callShim("/v1/models");
assert.equal(models.status, 200);
assert.deepEqual(models.body.data.map((m) => m.id).sort(), ["opencode/free-chat", "opencode/free-tool", "test/DeepSeek-V4-Flash"]);
console.log("2) /v1/models OK");

const bad = await callShim("/v1/chat/completions", { model: "opencode/free-chat", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "t", parameters: {} } }] });
assert.equal(bad.status, 400); assert.equal(bad.body.error.code, "tools_not_supported");
console.log("   chat-only tool request rejected OK");

const plain = await callShim("/v1/chat/completions", { model: "opencode/free-chat", messages: [{ role: "user", content: "hi" }] });
assert.equal(plain.status, 200);
assert.equal(plain.body.choices[0].message.content, "hello from chat");
assert.equal(plain.body.choices[0].finish_reason, "stop");
assert.equal(plain.body.usage.prompt_tokens, 11 + 1);
assert.equal(plain.body.usage.completion_tokens, 7 + 2);
console.log("3) non-stream chat (chat-only model) OK:", plain.body.choices[0].message);

// --- 4) streaming (bridge model -> SSE) -------------------------------------------------
const stream = await callShim("/v1/chat/completions", { model: "opencode/free-tool", messages: [{ role: "user", content: "hi" }], stream: true }, true);
assert.equal(stream.status, 200);
assert.ok(stream.headers["content-type"].startsWith("text/event-stream"));
assert.ok(stream.body.includes("chat.completion.chunk"));
assert.ok(stream.body.trim().endsWith("data: [DONE]"));
assert.ok(stream.body.includes("thinking")); // envelope content emitted
console.log("4) streaming SSE OK");

// --- 4b) custom-provider model routes with its OWN providerID (not hardcoded "opencode") --
const customPlain = await callShim("/v1/chat/completions", { model: "test/DeepSeek-V4-Flash", messages: [{ role: "user", content: "hi" }] });
assert.equal(customPlain.status, 200);
assert.equal(lastMessageBody.model.providerID, "test");
assert.equal(lastMessageBody.model.modelID, "DeepSeek-V4-Flash");
console.log("4b) custom provider routing OK:", JSON.stringify(lastMessageBody.model));

// --- 5) protocol decode: tool envelope -> OpenAI call -----------------------------------
const msg = decode('{"content":"run it","calls":[{"name":"bash","arguments":{"cmd":"ls"}}]}', { choice: "auto", tools: [{ function: { name: "bash" } }], forced: null, parallel: true });
assert.equal(msg.content, "run it");
assert.equal(msg.tool_calls.length, 1);
assert.equal(msg.tool_calls[0].function.name, "bash");
assert.equal(msg.tool_calls[0].function.arguments, '{"cmd":"ls"}');
console.log("5) protocol decode tool envelope OK");

// --- cleanup ----------------------------------------------------------------------------
shim.close();
mock.close();
console.log("\nALL BRIDGE TESTS PASSED");
