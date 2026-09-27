/**
 * Worker bindings. Secrets are never committed: set them with
 * `wrangler secret put <NAME>` for deployed environments, or in a local
 * `.dev.vars` (gitignored) for `wrangler dev`. See `.dev.vars.example`.
 */
export type Env = {
  /** xKiro API key. Required by every route that runs a model. */
  XKIRO_API_KEY?: string;

  /** Override the upstream base URL. Defaults to https://api.xkiro.com/v1 */
  XKIRO_BASE_URL?: string;

  /**
   * Comma-separated model IDs the gateway is allowed to forward, e.g.
   * "openai/gpt-5.6-sol,anthropic/claude-x". Empty or unset means any model
   * in the catalog, which also means any price in the catalog.
   */
  XKIRO_ALLOWED_MODELS?: string;

  /**
   * Comma-separated browser origins allowed to call the AI routes.
   * Unset means no CORS headers are emitted, so only same-origin and
   * server-to-server callers get through.
   */
  AI_ALLOWED_ORIGINS?: string;

  /**
   * Shared secret the caller must send as `x-opencut-ai-token`. When unset the
   * AI routes are open to anyone who can reach the Worker, and they spend your
   * xKiro balance. Set it for any deployment that is reachable publicly.
   */
  AI_GATEWAY_TOKEN?: string;
};
