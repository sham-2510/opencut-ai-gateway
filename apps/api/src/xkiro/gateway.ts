import type { Env } from "../env";
import {
  BLOCKING_TIMEOUT_MS,
  CHAT_COMPLETIONS_UPSTREAM,
  MAX_REQUEST_BYTES,
  MAX_RETRIES,
  PASSTHROUGH_RESPONSE_HEADERS,
  RETRYABLE_STATUSES,
  STREAMING_TIMEOUT_MS,
  XKIRO_DEFAULT_BASE_URL,
  type GatewayRoute,
} from "./constants";
import { GatewayError, backoffMs, isRetryableStatus } from "./errors";

export type GatewayConfig = {
  apiKey: string;
  baseUrl: string;
  /** `null` means every model in the catalog is permitted. */
  allowedModels: ReadonlySet<string> | null;
  allowedOrigins: ReadonlySet<string> | null;
  gatewayToken: string | null;
};

/**
 * What the gateway needs from an inbound call. Deliberately not a `Request`:
 * the HTTP framework has already consumed the body stream by the time a
 * handler runs, so re-reading the original would fail.
 */
export type ForwardInput = {
  /** Parsed JSON body for POST routes, ignored for GET. */
  body?: unknown;
  /** Caller's query string, forwarded when the route allows it. */
  query?: string;
  headers: Headers;
  signal?: AbortSignal;
  /** Extra path segment, used by image job polling. */
  pathSuffix?: string;
};

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export function resolveConfig(env: Env): GatewayConfig {
  const apiKey = env.XKIRO_API_KEY?.trim();
  if (!apiKey) {
    throw new GatewayError(
      "gateway_not_configured",
      "XKIRO_API_KEY is not set on this Worker. See apps/api/.dev.vars.example.",
    );
  }

  const models = csv(env.XKIRO_ALLOWED_MODELS);
  const origins = csv(env.AI_ALLOWED_ORIGINS);

  return {
    apiKey,
    baseUrl: (env.XKIRO_BASE_URL?.trim() || XKIRO_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    allowedModels: models.length > 0 ? new Set(models) : null,
    allowedOrigins: origins.length > 0 ? new Set(origins) : null,
    gatewayToken: env.AI_GATEWAY_TOKEN?.trim() || null,
  };
}

/**
 * The gateway holds a key that spends money, so when a shared secret is
 * configured it is required. When it is not configured these routes are open;
 * that is a local-development convenience, not a safe default for a publicly
 * reachable deployment.
 */
export function assertAuthorized(headers: Headers, config: GatewayConfig): void {
  if (!config.gatewayToken) return;

  const presented = headers.get("x-opencut-ai-token");
  if (!presented || !constantTimeEqual(presented, config.gatewayToken)) {
    throw new GatewayError(
      "gateway_unauthorized",
      "Missing or invalid x-opencut-ai-token header.",
    );
  }
}

/** Compare without an early exit, so a wrong token does not leak its prefix. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export function corsHeaders(headers: Headers, config: GatewayConfig): Headers {
  const out = new Headers();
  const origin = headers.get("origin");
  if (!origin || !config.allowedOrigins?.has(origin)) return out;

  out.set("access-control-allow-origin", origin);
  out.set("vary", "origin");
  out.set("access-control-allow-headers", "content-type,x-opencut-ai-token");
  out.set("access-control-allow-methods", "GET,POST,OPTIONS");
  out.set("access-control-max-age", "86400");
  return out;
}

type PreparedBody = { raw: string; streaming: boolean };

function prepareBody(body: unknown, route: GatewayRoute): PreparedBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GatewayError("invalid_request", "Request body must be a JSON object.");
  }

  const payload = { ...(body as Record<string, unknown>) };
  const streaming = payload.stream === true;

  // A streamed response only reports usage when the request asks for it, and
  // it arrives as its own frame after the one carrying finish_reason. Opting in
  // here keeps self-metering from reading zero forever.
  if (
    route.upstream === CHAT_COMPLETIONS_UPSTREAM &&
    streaming &&
    payload.stream_options === undefined
  ) {
    payload.stream_options = { include_usage: true };
  }

  const raw = JSON.stringify(payload);
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(
      "payload_too_large",
      `Request body exceeds ${MAX_REQUEST_BYTES} bytes.`,
    );
  }

  return { raw, streaming };
}

function assertModelAllowed(
  body: unknown,
  route: GatewayRoute,
  config: GatewayConfig,
): void {
  const model = (body as Record<string, unknown> | null | undefined)?.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new GatewayError("invalid_request", "`model` is required.");
  }
  // Chat/vision/image IDs are always `vendor/model`; a bare name 404s upstream.
  // Speech IDs are bare, so the check is per-route rather than global.
  if (route.requireVendorPrefix && !model.includes("/")) {
    throw new GatewayError(
      "invalid_request",
      `Model "${model}" is missing its vendor prefix, e.g. "openai/${model}".`,
    );
  }
  if (config.allowedModels && !config.allowedModels.has(model)) {
    throw new GatewayError(
      "model_not_allowed",
      `Model "${model}" is not in XKIRO_ALLOWED_MODELS.`,
    );
  }
}

/**
 * Forwards one call upstream with the API key attached.
 *
 * Retries only happen while no bytes have reached the caller, and only for
 * capacity statuses; `Retry-After` wins over any local formula. Retrying a
 * blocking POST does not double-bill, because xKiro fingerprints the key plus
 * the exact body for about two minutes and replays the first result. That
 * replay deliberately excludes streaming, which is why a stream is only
 * retried before its first byte is relayed.
 */
export async function forward(
  route: GatewayRoute,
  input: ForwardInput,
  config: GatewayConfig,
): Promise<Response> {
  const suffix = input.pathSuffix ? `/${encodeURIComponent(input.pathSuffix)}` : "";
  const query = route.forwardQuery && input.query ? `?${input.query}` : "";
  const url = `${config.baseUrl}/${route.upstream}${suffix}${query}`;

  const upstreamHeaders = new Headers({
    authorization: `Bearer ${config.apiKey}`,
    accept: input.headers.get("accept") ?? "application/json",
  });

  let prepared: PreparedBody | null = null;
  if (route.method === "POST") {
    assertModelAllowed(input.body, route, config);
    prepared = prepareBody(input.body, route);
    upstreamHeaders.set("content-type", "application/json");
  }

  const timeoutMs = prepared?.streaming ? STREAMING_TIMEOUT_MS : BLOCKING_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (input.signal) signals.push(input.signal);

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: route.method,
        headers: upstreamHeaders,
        body: prepared?.raw,
        // Closing this aborts the upstream call, so a cancelled generation
        // stops being billed from the point it was cancelled.
        signal: AbortSignal.any(signals),
      });
    } catch (cause) {
      if (input.signal?.aborted) {
        throw new GatewayError("upstream_unreachable", "Client closed the request.");
      }
      if (attempt >= MAX_RETRIES) {
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        throw new GatewayError(
          timedOut ? "upstream_timeout" : "upstream_unreachable",
          `xKiro request failed: ${String(cause)}`,
        );
      }
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (attempt >= MAX_RETRIES || !isRetryableStatus(upstream.status, RETRYABLE_STATUSES)) {
      return relay(upstream);
    }

    // Release the connection before sleeping on a retry.
    await upstream.body?.cancel();
    await sleep(backoffMs(attempt, upstream.headers.get("retry-after")));
  }
}

/** Streams the upstream response straight through, carrying useful headers. */
function relay(upstream: Response): Response {
  const headers = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Server-sent events must not be buffered or transformed by an intermediary.
  if (headers.get("content-type")?.includes("text/event-stream")) {
    headers.set("cache-control", "no-cache, no-transform");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
