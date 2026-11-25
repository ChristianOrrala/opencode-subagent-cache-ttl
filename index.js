// opencode-subagent-cache-ttl — shorter Anthropic prompt-cache lifetime for subagent sessions (OpenCode v2 plugin).
import { appendFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { createHook, parseOptions } from "./lib.js"

export default Plugin.define({
  id: "opencode-subagent-cache-ttl",
  setup: async (ctx) => {
    const options = ctx.options ?? {}
    const file = parseOptions(options).log ?? process.env.OPENCODE_SUBAGENT_CACHE_TTL_LOG
    const log = file
      ? (entry) => { try { appendFileSync(file, JSON.stringify(entry) + "\n") } catch {} }
      : undefined
    await ctx.session.hook("http.request", createHook(options, log))
  },
})
