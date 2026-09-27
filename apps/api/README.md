# OpenCut API

Elysia on Cloudflare Workers.

```sh
moon run api:dev        # wrangler dev, localhost:8787
moon run api:typecheck  # tsc --noEmit
moon run api:build      # wrangler deploy --dry-run
```

## Routes

| Method | Path             | Purpose                              |
| ------ | ---------------- | ------------------------------------ |
| `GET`  | `/`              | Liveness                             |
| `GET`  | `/health`        | Health with timestamp                |
| `POST` | `/echo`          | Echoes `{ message }`                 |
| `GET`  | `/ai/models`     | Model catalog                        |
| `GET`  | `/ai/voices`     | Voice catalog                        |
| `POST` | `/ai/chat`       | Chat, OpenAI dialect, streams        |
| `POST` | `/ai/messages`   | Chat, Anthropic dialect, streams     |
| `POST` | `/ai/count-tokens` | Token count for a Messages payload |
| `POST` | `/ai/speech`     | Text to speech, returns audio bytes  |
| `POST` | `/ai/images`     | Queue an image job, returns `202`    |
| `GET`  | `/ai/images/:id` | Poll an image job                    |

## The AI gateway

`/ai/*` is a thin pass-through to [xKiro](https://docs.xkiro.com), which fronts
several model vendors behind one API and speaks both the OpenAI Chat Completions
and Anthropic Messages formats.

The API key lives on this Worker and never leaves it. Anything running on a
user's device can be read by that user, so the browser talks to us and we talk
to xKiro. Request and response shapes are xKiro's own, unmodified, so an SDK
pointed at `<worker>/ai` keeps working — only the base URL changes.

### Configuration

Local development uses `.dev.vars` (gitignored, see `.dev.vars.example`).
Deployed environments use `wrangler secret put <NAME>`; plain vars in
`wrangler.jsonc` are stored in the clear and end up in the deployment record.

| Variable               | Required | Purpose                                                  |
| ---------------------- | -------- | -------------------------------------------------------- |
| `XKIRO_API_KEY`        | yes      | Key from the xKiro dashboard                             |
| `XKIRO_BASE_URL`       | no       | Defaults to `https://api.xkiro.com/v1`                   |
| `XKIRO_ALLOWED_MODELS` | no       | Comma-separated allowlist; unset means the whole catalog  |
| `AI_ALLOWED_ORIGINS`   | no       | Browser origins allowed to call `/ai/*`                  |
| `AI_GATEWAY_TOKEN`     | no\*     | Shared secret required as `x-opencut-ai-token`            |

\* Not required by the code, but **the routes are open without it**. Anyone who
can reach the Worker can spend the xKiro balance. Set it, plus a monthly
spending limit on the key itself, for anything publicly reachable.

### What the gateway adds

Everything below is behaviour the raw upstream API leaves to the caller.

- **Path allowlist.** Only the routes in the table above are forwardable. The
  gateway injects a key that spends money, so a capability is opted into
  deliberately rather than proxied by wildcard.
- **Model allowlist.** Optional, and worth setting: the catalog spans several
  orders of magnitude in price.
- **Vendor prefix check.** Chat and image IDs are always `vendor/model`, and a
  bare name returns a confusing upstream `404`. Speech IDs are bare
  (`xkiro-voice`), so the rule is per-route rather than global.
- **Usage frames on streams.** A streamed response only reports usage when the
  request asks for it, so `stream_options.include_usage` is set by default on
  `/ai/chat` — otherwise self-metering silently reads zero. An explicit value
  from the caller is left alone.
- **Retries that respect the error table.** Only `429`, `500`, `502`, `503` and
  `529` are retried, `Retry-After` beats any local formula, and the backoff is
  exponential with jitter. `400`–`404` are never retried; a content refusal is
  deliberately a `400` upstream so clients do not hammer it. Retrying a blocking
  POST does not double-bill, because xKiro fingerprints the key plus the exact
  body for about two minutes and replays the first result. That replay excludes
  streaming, which is why a stream is only retried before its first byte.
- **Cancellation.** A closed client connection aborts the upstream call, so a
  cancelled generation is billed for what it produced, not for the whole answer.
- **Timeouts.** Blocking calls get 120s, above the upstream 95s cut-off, so a
  slow-but-healthy request is answered rather than killed locally. Streams get
  ten minutes.
- **One error envelope.** Gateway failures use the same `{ error: { message,
  type, code } }` shape as upstream, with `type: "opencut_gateway_error"`.
  Branch on `type`/`code`, never on `message`.

### Streaming

`/ai/chat` and `/ai/messages` relay `text/event-stream` untouched, with
`cache-control: no-cache, no-transform` so nothing in between buffers it. Two
things to get right in a reader, both handled by
`apps/web/src/lib/ai/client.ts`:

- A network read can land mid-event. Buffer the tail and parse only complete
  events.
- The usage frame arrives *after* the one carrying `finish_reason` and has an
  **empty** `choices` array. Reading `choices[0]` unconditionally throws.

### Example

```sh
curl -N http://localhost:8787/ai/chat \
  -H 'content-type: application/json' \
  -H "x-opencut-ai-token: $AI_GATEWAY_TOKEN" \
  -d '{
    "model": "openai/gpt-5.6-sol",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count to five." }]
  }'
```

From the web app:

```ts
import { ai, useChat } from "#/lib/ai";

const { messages, partial, send, stop } = useChat({
  model: "openai/gpt-5.6-sol",
  system: "You are the OpenCut editing assistant.",
});

const catalog = await ai.listModels({ modality: "all" });
```

### Not wired up

`/v1/images/edits` is multipart rather than JSON and needs a different handler,
so it is not forwarded yet. Web search, web fetch and the MCP endpoint are also
left out — they are per-account rate limited and deserve their own policy.
