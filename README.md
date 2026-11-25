# opencode-subagent-cache-ttl

OpenCode plugin: **subagent sessions use a 5-minute Anthropic prompt-cache lifetime; main sessions keep whatever your provider is set to** (for example 1 hour).

## Why
Anthropic charges 2× the input price to write a 1-hour cache entry and 1.25× for a 5-minute one. A main session lives long enough to earn the 1-hour entry back; a subagent usually finishes in minutes, so its 1-hour writes are mostly wasted. OpenCode has one `cache.ttl` per provider and ignores it on model variants, so there is no built-in per-agent setting.

## Install
In `opencode.json`:
```json
{ "plugins": ["opencode-subagent-cache-ttl@git+https://github.com/ChristianOrrala/opencode-subagent-cache-ttl.git"] }
```
With options:
```json
{ "plugins": [{ "package": "opencode-subagent-cache-ttl@git+https://github.com/ChristianOrrala/opencode-subagent-cache-ttl.git",
                "options": { "childTtl": "5m", "agents": { "oracle": "1h" } } }] }
```
No build step, no dependencies. Tested with OpenCode 2.4.0 (plugin API v2).

## How it decides
It uses the `http.request` hook and edits only the `cache_control` markers in the outgoing JSON body.
1. Only the agent loop's requests (not titles, compaction) to models whose id matches `modelPattern` (default `claude`, case-insensitive; any provider or prefix, e.g. `claude-…`, `team/claude-…`).
2. A request is from a **subagent** if it carries `x-opencode-parent-session-id` or `x-parent-session-id`.
3. TTL = `agents[<agent name>]` if listed, else `childTtl` for subagents, else nothing: main sessions are left alone.
`5m` is the API default, so the `ttl` field is removed from the markers; any other value is written as given.
Nothing else in the request changes (the request is rebuilt from the original, so the abort signal is kept).

## Options
| option | default | meaning |
|---|---|---|
| `childTtl` | `"5m"` | TTL for subagent sessions |
| `agents` | `{}` | agent name → TTL, wins over the rule above, also for main sessions |
| `modelPattern` | `"claude"` | regex tested on the model id |
| `maxBodyBytes` | 33554432 | larger bodies are left alone |
| `logFile` | – | append one JSON line per rewritten request (env `OPENCODE_SUBAGENT_CACHE_TTL_LOG`) |

Anthropic requires 1-hour markers to come before 5-minute ones in a request; with a subagent all markers get the same value, so this cannot be violated by the default rule.

## Fails open
Missing headers or model, non-JSON or oversized body, no markers, any exception: the request goes out exactly as OpenCode built it.

## Verify
Run the proxy in `scripts/capture.py` against your provider and check the markers per request:
```sh
python3 scripts/capture.py 8899 out.jsonl https://example.com   # then set baseURL to http://127.0.0.1:8899/v1
```
Main-session requests show `ttl: 1h` markers, subagent requests show plain `{"type":"ephemeral"}`.
`npm test` runs the unit tests (Node 20+, `node:test`).

## License
MIT
