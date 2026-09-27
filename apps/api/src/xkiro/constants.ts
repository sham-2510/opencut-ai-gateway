/** Route table and policy constants for the xKiro gateway. */

export const XKIRO_DEFAULT_BASE_URL = "https://api.xkiro.com/v1";

export type GatewayRoute = {
  method: "GET" | "POST";
  /** Path under the xKiro base URL. */
  upstream: string;
  /**
   * Whether `model` must look like `vendor/model`. True for the model catalog
   * families, false for speech, where the ID is bare (`xkiro-voice`).
   */
  requireVendorPrefix?: boolean;
  /** Forward the caller's query string, e.g. `?modality=image`. */
  forwardQuery?: boolean;
};

/**
 * Upstream calls this gateway is willing to make, keyed by the name it exposes
 * under `/ai/`. An allowlist rather than a wildcard proxy: the gateway injects
 * a key that spends real money, so each capability is opted into deliberately.
 */
export const GATEWAY_ROUTES = {
  // Public upstream — these two need no key, and are cached for five minutes.
  models: { method: "GET", upstream: "models", forwardQuery: true },
  voices: { method: "GET", upstream: "audio/voices", forwardQuery: true },

  // Text. Two dialects over the same catalog; pick whichever the caller speaks.
  chat: { method: "POST", upstream: "chat/completions", requireVendorPrefix: true },
  messages: { method: "POST", upstream: "messages", requireVendorPrefix: true },
  "count-tokens": {
    method: "POST",
    upstream: "messages/count_tokens",
    requireVendorPrefix: true,
  },

  // Speech. Returns audio bytes, not JSON. Model IDs here are bare.
  speech: { method: "POST", upstream: "audio/speech", requireVendorPrefix: false },

  // Images are asynchronous: this returns 202 with a job ID to poll.
  images: { method: "POST", upstream: "images/generations", requireVendorPrefix: true },
} as const satisfies Record<string, GatewayRoute>;

export type GatewayRouteName = keyof typeof GATEWAY_ROUTES;

/** Job polling for image generation, which carries an ID in the path. */
export const IMAGE_JOB_UPSTREAM = "images/generations";

/** Upstream path that speaks the OpenAI Chat Completions dialect. */
export const CHAT_COMPLETIONS_UPSTREAM = "chat/completions";

/**
 * Statuses worth retrying, per the xKiro error table: capacity and timing
 * problems where the same request can succeed a moment later. Anything else in
 * the 4xx range is about the request itself and will not become valid on its
 * own — including content refusals, which are deliberately 400 rather than 500
 * so clients do not hammer a request that can never succeed.
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 529,
]);

export const MAX_RETRIES = 3;

/**
 * Upstream cuts blocking requests off at 95s. Sit above that so a slow but
 * healthy request is answered by the server rather than killed by us.
 */
export const BLOCKING_TIMEOUT_MS = 120_000;

/** A streamed response stays open for as long as the model keeps writing. */
export const STREAMING_TIMEOUT_MS = 600_000;

/** Ceiling on a forwarded body. Inline vision images are the large case. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Response headers worth surfacing to the caller. */
export const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "x-request-id",
] as const;
