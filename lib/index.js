// dsh-connect-opencode — expose OpenCode's free models as a DSH provider.
//
// Structure mirrors dsh-connect-workbuddy:
//   - an isolated `opencode serve` backend (lib/opencode.js)
//   - a local OpenAI-compat shim (lib/shim.js) that DSH's pi-ai talks to
//   - a PiAiAdapter + createProvider registering the models into DSH
//   - ctx.llm.registerAdapter / registerConfigurableProviders / registerModelDiscovery
//
// Unlike WorkBuddy (a paid subscription gateway), the models are opencode's own zero-cost
// catalog; there is no credential/credit logic here.

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";

import { findRuntime, startBackend } from "./opencode.js";
import { createShim } from "./shim.js";
import { freeModels, modelEntry } from "./catalog.js";

const name = "dsh-connect-opencode";
const inject = ["llm", "settings"];

// DSH itself ships built-in `opencode` / `opencode-go` providers (opencode.ai zen, paid).
// This plugin surfaces the LOCAL `opencode serve` catalog (free + user custom providers),
// so it must register under a distinct id to avoid the "already declared" collision.
const PROVIDER = "opencode-local";
const PROVIDER_DISPLAY = "OpenCode Local";
const SETTINGS_NS = "dsh-connect-opencode";
const STREAM_IDLE_TIMEOUT_MS = 3e5;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error(`${name}: the opencode route has no pi-ai credential lifecycle`); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};

// Mark a Config field volatile so DSH's settings service (dsh-settings describe()) actually
// SERVES this plugin's namespace. Without at least one volatile field, volatileForm() returns
// undefined and describe() skips the namespace entirely (dsh-settings/lib/index.js:418-419) —
// which is what hides the provider card from the 设置>模型 page while the chat model dropdown
// (a separate listProviders path) still shows it. The DSH model page renders a provider row ONLY
// when `namespaces.get(settingsNs)` resolves (settings-models/lib/client.js:1035/2069/2125).
// Mirrors dsh-connect-workbuddy, whose authFile/accounts/regions are all asVolatile.
// .volatile() exists from schemastery 3.18.3+; on older pins degrade to a no-op.
function asVolatile(schema) {
  return typeof schema?.volatile === "function" ? schema.volatile() : schema;
}
// A volatile field resolves to a live reference `{get():T}` at runtime, NOT the raw value.
// Reading it directly (e.g. `if (!config.enabled)`) is always truthy and misbehaves; unwrap
// every read, exactly like workbuddy's unwrapVolatile.
function unwrapVolatile(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

const Config = z.object({
  enabled: asVolatile(z.boolean().default(true).description("Whether the OpenCode provider is offered to DSH.")),
  binary: asVolatile(z.string().default("").description("Absolute path to the opencode executable. Empty = auto-discover from ~/.opencode/bin and the npm global.")),
  autoRefreshMin: asVolatile(z.number().step(1).default(15).description("Minutes between free-model catalog re-scans. 0 = never auto-refresh.")),
});

function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === "string" && id !== "" ? id : SETTINGS_NS;
}

/** Mutable catalog shared by the shim's /v1/models and the adapter snapshot. */
class OpencodeCatalog {
  constructor() { this._models = []; }
  current() { return this._models; }
  set(models) { this._models = models; }
}

/**
 * Clamp a catalog entry's token limits into a range DSH accepts.
 * Custom providers (e.g. the AMD gateway) often omit limits, reporting ctx=0/out=0;
 * `??` would keep those zeros and DSH rejects a 0 context window as "invalid context
 * metadata", so treat any non-positive number as missing. maxTokens stays strictly below
 * contextWindow. Shared by the adapter (toPiModel) and registerModelDiscovery.
 */
function safeLimits(entry) {
  const contextWindow = entry.contextWindow > 0 ? entry.contextWindow : 128000;
  let maxTokens = entry.maxTokens > 0 ? entry.maxTokens : 8192;
  if (maxTokens >= contextWindow) maxTokens = Math.floor(contextWindow / 2);
  return { contextWindow, maxTokens };
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(entry, baseUrl, providerId) {
  const { contextWindow, maxTokens } = safeLimits(entry);
  return {
    id: entry.id,
    name: entry.displayName ?? entry.name,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    input: entry.inputModalities,
    cost: NO_COST,
    contextWindow,
    maxTokens,
    reasoning: entry.reasoning,
    compat: { supportsReasoningEffort: entry.reasoning },
  };
}

function createOpencodeAdapter({ shim, catalog }) {
  const providerId = PROVIDER;
  const providerName = PROVIDER_DISPLAY;
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog.current().map((entry) => toPiModel(entry, baseUrl, providerId));
  };
  const provider = {
    ...createProvider({
      id: providerId,
      name: providerName,
      auth: { apiKey: { name: "OpenCode local shim bearer", async resolve() { return { auth: { apiKey: shim.token() }, source: "OpenCode" }; } } },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };
  const profile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(void 0, `${name} retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);
  return {
    adapter: new PiAiAdapter({ profiles: () => profiles, auth: INERT_AUTH, resolveApiKey: async () => shim.token() }),
    invalidate: () => { profiles = new Map([[providerId, profile]]); },
  };
}

function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx);
  const catalog = new OpencodeCatalog();
  let adapter = null;
  let backend = null;

  const dataDir = join(resolveDshHome(), name);
  const traceFile = join(dataDir, "startup-trace.log");
  const trace = (message, err) => {
    const line = `${new Date().toISOString()} ${message}${err ? ` :: ${err.stack || err.message || err}` : ""}\n`;
    try { appendFileSync(traceFile, line); } catch {}
    if (err) ctx.logger?.error?.(`${name}: ${message}`, err); else ctx.logger?.warn?.(`${name}: ${message}`);
  };
  const log = (message) => trace(message);

  const binarySetting = unwrapVolatile(config.binary);
  const candidates = binarySetting ? [binarySetting] : undefined;

  (async () => {
    let stopped = false;
    ctx.effect(() => () => { stopped = true; });

    // volatile fields are live references at runtime; always read through these getters.
    const enabled = () => unwrapVolatile(config.enabled);
    const refreshMin = () => unwrapVolatile(config.autoRefreshMin);

    trace(`apply start; enabled=${enabled()} binary=${binarySetting || "(auto)"} dataDir=${dataDir}`);
    if (!enabled()) {
      trace("provider disabled in settings; nothing registered.");
      return;
    }
    const binary = await findRuntime(candidates);
    if (!binary) {
      trace("opencode executable not found; provider not registered.");
      return;
    }
    trace(`runtime found: ${binary}; starting backend...`);
    const started = await startBackend(binary, dataDir, log);
    if (stopped) return started.stop();
    backend = started.backend;
    trace(`opencode serve ready (v${started.version}) at ${backend.base}.`);
    ctx.effect(() => () => started.stop());

    // Discover the free catalog BEFORE the shim goes live, so the provider registers with models.
    await refreshModels().catch((e) => trace("initial model scan failed", e));
    trace(`catalog: ${catalog.current().length} free model(s).`);

    const shim = createShim({
      getModels: () => catalog.current(),
      complete: (request, signal) => backend.complete(request, signal),
    });
    await shim.ready;
    trace(`shim live at ${shim.baseUrl()}; building adapter...`);

    adapter = createOpencodeAdapter({ shim, catalog });
    trace("adapter built; registering with host...");
    const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter.adapter);
    const releaseDirectory = ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER,
      displayName: PROVIDER_DISPLAY,
      settingsNs,
      settingsPath: [],
      declared: false,
    }]);
    ctx.effect(() => () => {
      releaseAdapter?.();
      releaseDirectory?.();
      shim.close();
    });
    trace(`registered (adapter=${typeof releaseAdapter} directory=${typeof releaseDirectory}).`);

    ctx.llm.registerModelDiscovery(settingsNs, async () => {
      if (!enabled()) return [];
      await refreshModels().catch((e) => trace("refresh failed", e));
      return catalog.current().map((m) => ({
        id: m.id,
        name: m.displayName ?? m.name,
        ...safeLimits(m),
        inputModalities: m.inputModalities,
      }));
    });

    trace(`DONE: provider registered at ${shim.baseUrl()} with ${catalog.current().length} free model(s).`);

    // Auto-refresh timer, rebuilt when the user changes autoRefreshMin in the settings
    // page. volatile fields resolve to live references, so read via refreshMin(); only the
    // timer is re-created here (safe), provider registration itself is untouched. Live
    // toggling `enabled` (register/unregister the whole provider) is NOT reconciled — flip
    // it and restart DSH for that to take effect.
    let refreshTimer = null;
    const restartTimer = () => {
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
      const mins = refreshMin();
      if (mins > 0) {
        refreshTimer = setInterval(() => refreshModels().catch((e) => trace("auto-refresh failed", e)), mins * 60000);
        refreshTimer.unref?.();
      }
    };
    restartTimer();
    const offVolatile = ctx.on?.("loader/volatile-update", () => { restartTimer(); });
    ctx.effect(() => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      if (typeof offVolatile === "function") offVolatile();
    });
  })().catch((e) => trace("STARTUP FAILED", e));

  async function refreshModels() {
    if (!backend) return;
    const providers = await backend.providers();
    catalog.set(freeModels(providers).map(modelEntry));
    adapter?.invalidate();
  }
}

export { name, inject, Config, apply, createOpencodeAdapter, OpencodeCatalog };
