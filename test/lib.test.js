import { test } from "node:test"
import assert from "node:assert/strict"
import { createHook, rewriteMarkers, parseOptions } from "../lib.js"

const body = () => ({
  model: "claude-x",
  messages: [
    { role: "system", content: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] },
    { role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral" } }] },
  ],
  tools: [{ type: "function", function: { name: "t" }, cache_control: { type: "ephemeral", ttl: "1h" } }],
})

const mk = (payload, { child = false, headers = {}, signal, method = "POST" } = {}) => {
  const h = new Headers({ "content-type": "application/json", authorization: "Bearer test", ...headers })
  if (child) h.set("x-opencode-parent-session-id", "ses_parent")
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  h.set("content-length", String(Buffer.byteLength(text)))
  return new Request("http://example.com/v1/chat/completions", { method, headers: h, body: text, signal })
}
const ev = (request, over = {}) => ({ kind: "primary", agent: "explorer", model: { id: "team-a/claude-haiku-5-5" }, sessionID: "ses_1", request, ...over })
const run = async (event, options) => { await createHook(options)(event); return event }
const markers = (j) => JSON.stringify(j).match(/"cache_control":\{[^}]*\}/g)

test("rewrite 5m removes ttl; other ttl sets it; idempotent", () => {
  const a = body(); assert.deepEqual(rewriteMarkers(a, "5m"), { seen: 3, changed: 2 })
  assert.deepEqual(markers(a), Array(3).fill('"cache_control":{"type":"ephemeral"}'))
  assert.equal(rewriteMarkers(a, "5m").changed, 0)
  const b = body(); rewriteMarkers(b, "30m"); assert.equal(markers(b).filter((m) => m.includes('"30m"')).length, 3)
})

test("child gets 5m, only cache_control changes", async () => {
  const e = ev(mk(body(), { child: true })); const orig = e.request
  await run(e)
  assert.notEqual(e.request, orig)
  const j = await e.request.json(); const expected = body(); rewriteMarkers(expected, "5m")
  assert.deepEqual(j, expected)
  assert.equal(e.request.headers.get("authorization"), "Bearer test")
  assert.equal(e.request.headers.get("content-length"), null)
  assert.equal(e.request.method, "POST"); assert.equal(e.request.url, orig.url)
})

test("primary session untouched (same object)", async () => {
  const e = ev(mk(body())); const orig = e.request
  await run(e); assert.equal(e.request, orig)
})

test("x-parent-session-id alone also marks a child", async () => {
  const e = ev(mk(body(), { headers: { "x-parent-session-id": "p" } })); const orig = e.request
  await run(e); assert.notEqual(e.request, orig)
})

test("per-agent map overrides, even for a primary session; invalid entries ignored", async () => {
  const e = ev(mk(body()), { agent: "orchestrator" }); const orig = e.request
  await run(e, { agents: { orchestrator: "5m", bad: "soon" } }); assert.notEqual(e.request, orig)
  assert.equal(Object.keys(parseOptions({ agents: { bad: "soon" } }).agents).length, 0)
  const c = ev(mk(body(), { child: true }), { agent: "oracle" })
  await run(c, { agents: { oracle: "1h" } })
  assert.equal(markers(await c.request.json()).filter((m) => m.includes('"ttl":"1h"')).length, 3)
})

test("childTtl option", async () => {
  const e = ev(mk(body(), { child: true })); await run(e, { childTtl: "10m" })
  assert.equal(markers(await e.request.json()).every((m) => m.includes("10m")), true)
})

test("model pattern: non-claude ids untouched; prefixes do not matter; custom pattern", async () => {
  for (const id of ["gpt-6.2-sol", "team-a/gpt-6.2-sol"]) {
    const e = ev(mk(body(), { child: true }), { model: { id } }); const o = e.request; await run(e); assert.equal(e.request, o)
  }
  for (const id of ["claude-haiku-5-5", "team-a/claude-haiku-5-5", "team-b/claude-sonnet-5-5", "a/b/Claude-X"]) {
    const e = ev(mk(body(), { child: true }), { model: { id } }); const o = e.request; await run(e); assert.notEqual(e.request, o, id)
  }
  const e = ev(mk(body(), { child: true }), { model: { id: "gpt-6" } }); const o = e.request
  await run(e, { modelPattern: "gpt" }); assert.notEqual(e.request, o)
})

test("non-JSON, GET, empty and non-primary requests untouched", async () => {
  const cases = [
    ev(mk("not json at all", { child: true, headers: { "content-type": "text/plain" } })),
    ev(mk("{broken", { child: true })),
    ev(new Request("http://example.com/v1/models", { method: "GET", headers: { "x-parent-session-id": "p" } })),
    ev(mk(body(), { child: true }), { kind: "title" }),
    ev(mk({ messages: [] }, { child: true })),
  ]
  for (const e of cases) { const o = e.request; await run(e); assert.equal(e.request, o) }
})

test("oversized bodies untouched", async () => {
  const e = ev(mk(body(), { child: true })); const o = e.request
  await run(e, { maxBodyBytes: 100 }); assert.equal(e.request, o)
})

test("errors fail open and are logged", async () => {
  const logs = []
  const e = ev(mk(body(), { child: true }))
  Object.defineProperty(e, "request", { get: () => { throw new Error("boom") }, set() {}, configurable: true })
  await createHook({}, (x) => logs.push(x))(e)
  assert.match(logs[0].error, /boom/)
  const missing = { kind: "primary" }; await createHook({})(missing) // no request/model: no throw
  const e2 = ev(mk(body(), { child: true }), { model: undefined }); const o2 = e2.request; await run(e2); assert.equal(e2.request, o2)
})

test("abort signal and other properties survive the rebuild", async () => {
  const ac = new AbortController()
  const e = ev(mk(body(), { child: true, signal: ac.signal })); const orig = e.request
  await run(e); assert.notEqual(e.request, orig)
  assert.equal(e.request.signal.aborted, false)
  ac.abort(new Error("cancelled"))
  assert.equal(e.request.signal.aborted, true)
  assert.equal(e.request.signal.reason.message, "cancelled")
  // already-aborted before the hook runs
  const ac2 = new AbortController(); ac2.abort()
  const e2 = ev(mk(body(), { child: true, signal: ac2.signal })); await run(e2)
  assert.equal(e2.request.signal.aborted, true)
})

test("rebuilt request really aborts an in-flight fetch", async () => {
  const { createServer } = await import("node:http")
  const server = createServer(() => {}) // never answers
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const ac = new AbortController()
  const req = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()), signal: ac.signal })
  const child = new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-parent-session-id": "p" }, body: JSON.stringify(body()), signal: ac.signal })
  const e2 = ev(child); await run(e2)
  const pending = fetch(e2.request)
  setTimeout(() => ac.abort(), 50)
  await assert.rejects(pending, (err) => err.name === "AbortError" || /abort/i.test(String(err)))
  server.closeAllConnections?.(); server.close()
})
