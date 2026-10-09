// Locate the OpenCode binary and run an isolated `opencode serve`. Ported (and simplified) from
// ow-bridge/src/runtime.js. The DSH host spawns plugins OUTSIDE the agent sandbox, so child
// spawning works in production; here we keep the same env contract for parity.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

function isWindows() {
  return process.platform === "win32";
}

function binaryName() {
  return isWindows() ? "opencode.exe" : "opencode";
}

/**
 * Candidate locations for an existing OpenCode install, in priority order. The `OPENCODE_BIN`
 * env overrides everything (the settings card writes it).
 */
export function runtimeCandidates(env = process.env, home = os.homedir()) {
  const p = isWindows() ? path.win32 : path.posix;
  const installed = isWindows()
    ? [
        p.join(home, ".opencode", "bin", binaryName()),
        p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), "npm", "node_modules", "opencode-ai", "bin", binaryName()),
        p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "opencode", "opencode-cli.exe"),
      ]
    : [p.join(home, ".opencode", "bin", binaryName()), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];
  return [env.OPENCODE_BIN, ...installed].filter(Boolean);
}

/** Pick the first candidate that reports a sane version. Returns the file path or null. */
export async function findRuntime(candidates = runtimeCandidates()) {
  for (const file of candidates) {
    if (/\.(?:cmd|bat|ps1)$/i.test(file)) continue; // a launcher shim is not an executable
    try {
      const out = (await exec(file, ["--version"], { timeout: 15000, windowsHide: true })).stdout.trim();
      if (/^\d+\.\d+\.\d+/.test(out)) return file;
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const n = s.address().port;
      s.close(() => resolve(n));
    });
  });
}

const NATIVE_PERMISSIONS = {
  "*": "ask",
  question: "deny",
  websearch: "deny",
  codesearch: "deny",
  webfetch: "deny",
  task: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  todowrite: "deny",
};

const ISOLATED_CONFIG = {
  permission: NATIVE_PERMISSIONS,
  autoupdate: false,
  share: "disabled",
  agent: {
    "buddy-chat": {
      mode: "primary",
      description: "Text-only external conversation",
      prompt: "Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.",
      permission: NATIVE_PERMISSIONS,
    },
    "buddy-bridge": {
      mode: "primary",
      description: "External client inference only",
      prompt: "You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.",
      permission: NATIVE_PERMISSIONS,
    },
  },
};

/**
 * Launch an isolated OpenCode server. Returns { backend, stop, version }.
 * `dataDir` is where the isolated XDG home is created (a writable plugin/data dir).
 */
export async function startBackend(binary, dataDir, log = () => {}) {
  const actualVersion = (await exec(binary, ["--version"], { timeout: 15000, windowsHide: true })).stdout.trim();
  const home = os.homedir();
  const root = path.join(dataDir, "opencode");
  for (const d of ["config", "data", "cache", "state", "project"]) mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });

  const env = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC"])
    if (process.env[k]) env[k] = process.env[k];
  for (const name of ["config", "data", "cache", "state"]) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);

  // Seed the isolated XDG tree from the user's real OpenCode install so custom providers and
  // their credentials work here too: provider definitions from the global config, auth.json
  // (API keys) from the data home. Files are copied into the isolated dirs, never modified.
  const seedFrom = [
    [path.join(home, ".config", "opencode", "opencode.json"), path.join(root, "config", "opencode", "opencode.json")],
    [path.join(home, ".config", "opencode", "opencode.jsonc"), path.join(root, "config", "opencode", "opencode.jsonc")],
    [path.join(home, ".local", "share", "opencode", "auth.json"), path.join(root, "data", "opencode", "auth.json")],
  ];
  for (const [src, dst] of seedFrom) {
    try {
      if (!existsSync(src)) continue;
      mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o600); } catch {}
      log(`seeded ${path.basename(src)} into isolated ${path.relative(root, path.dirname(dst))}`);
    } catch (e) {
      log(`seed ${path.basename(src)} failed: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  const password = randomBytes(24).toString("hex");
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(ISOLATED_CONFIG),
  });

  const port = await freePort();

  // A fresh isolated XDG tree has no cached provider catalog; refresh it before serve
  // (same step ow-bridge runs). Failure is non-fatal: the server may fetch on demand.
  await exec(binary, ["models", "opencode", "--refresh", "--pure"], {
    cwd: path.join(root, "project"),
    env,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((e) => log(`catalog refresh failed (continuing): ${String(e.message || e).slice(0, 200)}`));

  const child = spawn(binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "project"),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log(`[opencode] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => log(`[opencode:err] ${d.toString().trim()}`));
  let failure;
  child.on("error", (e) => {
    failure = e;
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const backend = new Backend(`http://127.0.0.1:${port}`, password, log);
  try {
    for (let i = 0; i < 120; i++) {
      if (failure || child.exitCode !== null) throw failure || new Error(`OpenCode exited: ${child.exitCode}`);
      try {
        const health = await backend.request("/global/health", "GET", undefined, undefined, 1000);
        if (health.healthy) return { backend, stop, version: health.version };
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("OpenCode startup timed out");
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Minimal OpenCode HTTP client. OpenCode authenticates with HTTP Basic. */
export class Backend {
  constructor(base, password, log = () => {}) {
    Object.assign(this, { base, password, log });
  }
  headers() {
    return { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` };
  }
  async request(route, method = "GET", body, signal, timeout = 20000) {
    const res = await fetch(this.base + route, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    }).catch((e) => {
      throw Object.assign(new Error(`OpenCode request failed: ${e.message}`), { status: 502, code: "upstream_error" });
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`OpenCode HTTP ${res.status}: ${text.slice(0, 600)}`), { status: res.status >= 500 ? 502 : res.status, code: "upstream_error" });
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("OpenCode returned non-JSON response"), { status: 502, code: "upstream_error" });
    }
  }

  /** The opencode provider catalog (used for free-model discovery). */
  async providers() {
    return this.request("/provider");
  }

  /**
   * One bounded chat turn. Creates a session with every native tool denied (the external client
   * — DSH — owns execution), sends the message, reads the envelope back, then cleans up.
   */
  async complete(request, signal) {
    const session = await this.request(
      "/session",
      "POST",
      {
        title: "dsh-connect-opencode",
        permission: Object.entries(NATIVE_PERMISSIONS).map(([permission, action]) => ({ permission, pattern: "*", action })),
      },
      signal,
    );
    const route = `/session/${encodeURIComponent(session.id)}`;
    let successful = false;
    try {
      const callsSchema = {
        type: "array",
        ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === "required" || request.forced ? { minItems: 1 } : {}),
        ...(request.tools.length
          ? { items: { anyOf: request.tools.map(({ function: tool }) => ({
              type: "object",
              properties: { name: { type: "string", const: tool.name }, arguments: tool.parameters || { type: "object" } },
              required: ["name", "arguments"],
              additionalProperties: false,
            })) } }
          : { maxItems: 0, items: { type: "object" } }),
      };
      const [providerID, ...rest] = String(request.model.id).split("/");
      const payload = {
        model: { providerID, modelID: rest.join("/") },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? "buddy-chat" : "buddy-bridge",
        system: request.chatOnly ? request.system : request.system + "\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.",
        ...(request.chatOnly ? {} : { format: { type: "json_schema", retryCount: 0, schema: { type: "object", properties: { content: { type: "string" }, calls: callsSchema }, required: ["content", "calls"], additionalProperties: false } } }),
        parts: [{ type: "text", text: request.text }, ...(request.images ?? [])],
      };
      const response = await this.request(`${route}/message`, "POST", payload, signal, null);
      if (response.info?.error && (request.chatOnly || response.info.error.name !== "StructuredOutputError")) {
        const error = response.info.error;
        throw Object.assign(new Error(error.data?.message || error.message || error.name || "Model request failed"), { status: error.data?.statusCode || 502, code: "model_error" });
      }
      if (response.parts?.some((p) => p.type === "tool" && (request.chatOnly || !["StructuredOutput", "invalid"].includes(p.tool)))) {
        throw Object.assign(new Error("Unexpected native tool activity; response rejected"), { status: 502, code: "native_tool_activity" });
      }
      const structuredPart = (response.parts || []).find((p) => p.type === "tool" && p.tool === "StructuredOutput" && p.state?.status === "completed" && p.state?.input);
      const envelope = response.info?.structured ?? structuredPart?.state?.input;
      const text = envelope !== undefined ? JSON.stringify(envelope) : (response.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
      if (response.info?.finish === "length") throw Object.assign(new Error("Model output was truncated"), { status: 502, code: "output_truncated" });
      if (!text.trim()) throw Object.assign(new Error("Model returned no text"), { status: 502, code: "invalid_model_output" });
      successful = true;
      return { text, tokens: response.info?.tokens };
    } finally {
      if (!successful) await this.request(`${route}/abort`, "POST", undefined, undefined, 5000).catch(() => {});
      await this.request(route, "DELETE", undefined, undefined, 5000).catch(() => {});
    }
  }
}
