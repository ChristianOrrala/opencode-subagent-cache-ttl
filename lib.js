// Pure logic, no OpenCode imports, so it can be tested on its own.
export const PARENT_HEADERS = ["x-opencode-parent-session-id", "x-parent-session-id"]
const TTL = /^\d+(ms|s|m|h|d)$/
const DEFAULT_MAX_BODY = 32 * 1024 * 1024

/** Sets the lifetime on every `cache_control` marker in a request body (mutates). "5m" is the API default, so the
 *  field is removed instead of written. Returns { seen, changed }. */
export function rewriteMarkers(node, ttl, state = { seen: 0, changed: 0 }) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteMarkers(item, ttl, state)
    return state
  }
  if (node === null || typeof node !== "object") return state
  const cc = node.cache_control
  if (cc && typeof cc === "object" && cc.type === "ephemeral") {
    state.seen++
    if (ttl === "5m") {
      if (cc.ttl !== undefined) { delete cc.ttl; state.changed++ }
    } else if (cc.ttl !== ttl) {
      cc.ttl = ttl
      state.changed++
    }
  }
  for (const key of Object.keys(node)) if (key !== "cache_control") rewriteMarkers(node[key], ttl, state)
  return state
}

export function parseOptions(o = {}) {
  const valid = (v) => typeof v === "string" && TTL.test(v)
  let modelPattern
  try { modelPattern = new RegExp(typeof o.modelPattern === "string" ? o.modelPattern : "claude", "i") }
  catch { modelPattern = /claude/i }
  const agents = {}
  if (o.agents && typeof o.agents === "object") for (const [k, v] of Object.entries(o.agents)) if (valid(v)) agents[k] = v
  return {
    childTtl: valid(o.childTtl) ? o.childTtl : "5m",
    agents,
    modelPattern,
    maxBody: Number.isFinite(o.maxBodyBytes) ? o.maxBodyBytes : DEFAULT_MAX_BODY,
    log: typeof o.logFile === "string" ? o.logFile : undefined,
  }
}

/** Decides the lifetime for a request: undefined means "leave it alone". */
export function decide(cfg, { agent, isChild }) {
  const mapped = agent !== undefined ? cfg.agents[String(agent)] : undefined
  return mapped ?? (isChild ? cfg.childTtl : undefined)
}

/** Returns the `http.request` hook callback. `log(entry)` is optional. Never throws: any problem leaves the request. */
export function createHook(options, log = () => {}) {
  const cfg = parseOptions(options)
  return async (event) => {
    try {
      if (event.kind !== "primary") return
      if (!cfg.modelPattern.test(String(event.model?.id ?? ""))) return
      const req = event.request
      if (!req || req.method !== "POST" || !req.body) return
      if (!(req.headers.get("content-type") ?? "").includes("json")) return
      const isChild = PARENT_HEADERS.some((h) => req.headers.has(h))
      const ttl = decide(cfg, { agent: event.agent, isChild })
      if (!ttl) return
      const len = Number(req.headers.get("content-length"))
      if (Number.isFinite(len) && len > cfg.maxBody) return
      const text = await req.clone().text()
      if (text.length > cfg.maxBody || !text.includes('"cache_control"')) return
      const body = JSON.parse(text)
      const state = rewriteMarkers(body, ttl)
      log({ session: event.sessionID, agent: event.agent, model: event.model?.id, child: isChild, ttl, ...state })
      if (state.changed === 0) return
      const headers = new Headers(req.headers)
      headers.delete("content-length")
      // Built from the original so the abort signal, method, credentials and every other property carry over.
      event.request = new Request(req, { body: JSON.stringify(body), headers })
    } catch (error) {
      log({ error: String(error?.message ?? error) })
    }
  }
}
