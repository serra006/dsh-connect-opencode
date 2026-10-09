// Local OpenAI-compatible endpoint DSH's pi-ai talks to. Mirrors ow-bridge/server.js but drops the
// admin routes (DSH calls registerModelDiscovery directly) and keeps only /v1/models +
// /v1/chat/completions. Authenticated with a per-process random bearer secret.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { prepare, decode, completion, sendSSE, BridgeError } from "./protocol.js";

function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new BridgeError("Request exceeds 8 MB", 413, "payload_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new BridgeError("Invalid JSON"); }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * @param {(request, signal)=>Promise<{text:string, tokens?:any}>} complete bound to the backend;
 *        `request` is the shaped object from protocol.prepare().
 * @param {()=>any[]} getModels current free-model catalog (each entry has id, chatOnly, images...)
 */
export function createShim({ complete, getModels }) {
  const token = randomBytes(24).toString("hex");
  const active = new Set();
  const server = createServer(async (req, res) => {
    if (!authorized(req, token)) return json(res, 401, { error: { message: "Local proxy API key required", type: "authentication_error" } });
    if (req.headers.origin) return json(res, 403, { error: { message: "Browser-origin requests are disabled" } });
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    const controller = new AbortController();
    active.add(controller);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.method === "GET" && route === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && (route === "/v1/models" || route === "/models"))
        return json(res, 200, { object: "list", data: getModels().map((m) => ({ id: m.id, object: "model", owned_by: "opencode", name: m.displayName ?? m.id })) });
      if (req.method !== "POST" || route !== "/v1/chat/completions") return json(res, 404, { error: { message: "Not found" } });

      const body = await readBody(req);
      const request = prepare(body, getModels()); // validates role/model/tools and shapes the request
      if (body.stream) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

      const { text, tokens } = await complete(request, controller.signal);
      if (controller.signal.aborted) return;

      const message = request.chatOnly ? { role: "assistant", content: text } : decode(text, request);
      const result = completion(request.model.id, message, tokens ?? {});
      result.model = body.model;
      if (body.stream) sendSSE(res, result, body.stream_options?.include_usage);
      else json(res, 200, result);
    } catch (e) {
      if (controller.signal.aborted) return;
      const error = { message: e.message, type: e.code || "upstream_error", code: e.code || "upstream_error" };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error })}\n\n`);
      else json(res, e.status || 502, { error });
    } finally { active.delete(controller); }
  });
  server.requestTimeout = 0; // local inference has no proxy-owned deadline
  server.headersTimeout = 15000;

  return {
    token: () => token,
    close: () => { for (const c of active) c.abort(); server.close(); },
    ready: new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server))),
    baseUrl: () => {
      const a = server.address();
      return a ? `http://127.0.0.1:${a.port}` : "";
    },
    server,
  };
}
