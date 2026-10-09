// Discover free models from OpenCode's own provider catalog (adapted from ow-bridge freeModels).
// A model is "free" iff every cost dimension is 0 (custom providers omit cost -> default 0);
// text output must be declared; deprecated excluded. Only providers the user has actually
// *connected* are considered — the full catalog lists hundreds of unauthenticated providers
// whose models would fail on selection.

/**
 * @param {any} providers the GET /provider response ({ all, default, connected }) — or a bare array.
 * @returns {{id:string, providerID:string, modelID:string, name:string, context?:number, input?:number, output?:number, images:boolean, toolcall:boolean, reasoning:boolean, variants:Record<string,unknown>}}[]
 */
export function freeModels(providers) {
  const all = providers.all ?? providers;
  // `connected` = ids the user is signed into / configured a key for. If it's missing
  // (older opencode, or a bare array in tests) fall back to scanning every provider.
  const connected = Array.isArray(providers?.connected) ? new Set(providers.connected) : null;
  const list = [];
  for (const provider of all) {
    if (!provider?.id) continue;
    if (connected && !connected.has(provider.id)) continue;
    for (const [modelID, m] of Object.entries(provider.models ?? {})) {
      const c = m.cost;
      const isFree = !c || (c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0);
      if (!isFree) continue;
      if (m.capabilities?.output?.text === false) continue;
      if (m.status === "deprecated") continue;
      list.push({
        id: `${provider.id}/${modelID}`,
        providerID: provider.id,
        modelID,
        name: m.name || modelID,
        context: m.limit?.context,
        input: m.limit?.input,
        images: m.capabilities?.input?.image === true,
        output: m.limit?.output,
        toolcall: m.capabilities?.toolcall === true,
        reasoning: m.capabilities?.reasoning === true,
        variants: m.variants ?? {},
      });
    }
  }
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

/** A model entry as DSH's adapter/catalog consumes it. `id` already carries the `opencode/` prefix. */
export function modelEntry(m) {
  return {
    id: m.id,
    name: m.name,
    displayName: `OC · ${m.name}`,
    contextWindow: m.input ?? m.context,
    maxTokens: m.output,
    inputModalities: m.images ? ["text", "image"] : ["text"],
    reasoning: m.reasoning,
    toolcall: m.toolcall,
    variants: m.variants,
    chatOnly: m.toolcall === false,
  };
}
