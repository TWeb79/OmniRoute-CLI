# Backlog

Found by code review before any fixes. Status: `[ ]` open, `[x]` fixed, `[-]` deferred.

## Bugs

- [x] **B1 Streaming has no status/headers.** `reply.hijack()` skips Fastify's header writing, so status and `content-type: text/event-stream` are never sent on `/v1/chat/completions` and `/v1/messages` streams.
- [x] **B2 Compressed responses corrupted.** Upstream `content-encoding`/`content-length` are copied, but `fetch` already decompressed the body, so clients fail to decode.
- [x] **B3 Network errors skip fallback.** `fetch` throwing (DNS, refused, reset) crashes the request instead of trying the next provider.
- [x] **B4 Task routing never changes the model.** `preferred_model` only picks a provider; `body.model` is still the original, so the preferred model is never requested.
- [x] **B5 Task routing matches too eagerly.** Substring match ("api" in "capital", "class" in "classic") over *all* user messages (comment says last one). With Claude Code's long prompts every request matches "code".
- [x] **B6 Fallback sends wrong model.** `findProvider` falls back to `providers[0]` even if it doesn't serve the model, and fallback providers get the same model name they don't have, so they always fail.
- [x] **B7 Auth ignores `x-api-key`.** Claude Code / Anthropic SDK send `x-api-key`, not `Authorization: Bearer`, so auth-enabled gateway rejects them. Hook also doesn't `return reply` after sending 401.
- [x] **B8 `auth.enabled` without `api_key`** silently locks everyone out (null !== undefined).
- [x] **B9 Anthropic bridge drops tools.** `tools`, `tool_use`, `tool_result` blocks, `tool_choice`, images are discarded, so Claude Code cannot work through `/v1/messages`.
- [x] **B10 Anthropic bridge drops sampling params** (`temperature`, `top_p`, `stop_sequences`).
- [x] **B11 Missing `/v1/messages/count_tokens`** which Claude Code calls.
- [x] **B12 Errors on `/v1/messages` use OpenAI shape**; Anthropic clients expect `{type:"error",error:{type,message}}`. `fromOpenAI` also throws on non-JSON upstream bodies.
- [x] **B13 Stream pump has no error/backpressure/disconnect handling**; a mid-stream upstream error is an unhandled rejection that can crash the process.
- [x] **B14 Missing `model`/`messages` crash** (`body.model.startsWith` on undefined) → 500 instead of 400.
- [x] **B15 Default 1 MB body limit** rejects large Claude Code contexts with 413.
- [x] **B16 Binds to `0.0.0.0` with auth off by default**, exposing your provider keys to the LAN.
- [x] **B17 `--dry-run` prompts for keys** before validating; prompting hangs when not a TTY (service use). Missing `${ENV}` silently becomes empty.
- [x] **B18 README wrong for Claude Code:** `ANTHROPIC_BASE_URL` must NOT include `/v1` (client appends `/v1/messages`). Banner omits `/v1/messages`. README says "not functional".
- [x] **B19 `npm run dev` broken** (uses `ts-node`, not installed).

## Pending / not fixing now

- [-] P1 Test coverage is one smoke test (`npm test`): auth, fallback, tools, streaming. No unit tests per module.
- [x] P2 60s upstream connect/header timeout added. [-] Client-abort propagation to upstream still not done.
- [x] P3 `/v1/models` doesn't list `model_map` aliases.
- [x] P4 Streaming usage now reported via `stream_options.include_usage`. [-] reasoning-content deltas still ignored.
- [x] P5 Round-robin counter is global per-process; `random` shuffle via `sort` is biased.
- [-] P6 No git repo; `dist/` and `config.yml` are gitignored (good) but nothing is version-controlled.
- [x] P7 Image blocks translated to `image_url` parts (user messages).

## Not verified

- Nothing was run against real NVIDIA/OpenAI/Anthropic endpoints (no live calls made); the smoke test uses a fake upstream.
- Model IDs in `config.yml` are unchecked against the live catalogs.
