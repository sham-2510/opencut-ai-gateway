import { Elysia } from "elysia";
import { env as workerEnv } from "cloudflare:workers";

import type { Env } from "../env";
import {
  GATEWAY_ROUTES,
  IMAGE_JOB_UPSTREAM,
  type GatewayRoute,
  type GatewayRouteName,
} from "../xkiro/constants";
import { GatewayError } from "../xkiro/errors";
import {
  assertAuthorized,
  corsHeaders,
  forward,
  resolveConfig,
  type ForwardInput,
} from "../xkiro/gateway";

/**
 * The xKiro gateway.
 *
 * The API key lives here and never leaves the Worker: anything running on a
 * user's device can be read by that user, so the browser talks to us and we
 * talk to xKiro. Every route is a thin, dialect-preserving pass-through — the
 * request and response shapes are xKiro's own, so an OpenAI or Anthropic SDK
 * pointed at `<worker>/ai` keeps working unchanged.
 */

type Context = {
  request: Request;
  body?: unknown;
  params?: Record<string, string>;
};

const readEnv = (): Env => workerEnv as unknown as Env;

async function handle(
  route: GatewayRoute,
  ctx: Context,
  extra: Partial<ForwardInput> = {},
): Promise<Response> {
  const headers = ctx.request.headers;
  let cors = new Headers();

  try {
    const config = resolveConfig(readEnv());
    cors = corsHeaders(headers, config);
    assertAuthorized(headers, config);

    const response = await forward(
      route,
      {
        body: ctx.body,
        query: new URL(ctx.request.url).search.slice(1),
        headers,
        signal: ctx.request.signal,
        ...extra,
      },
      config,
    );

    for (const [name, value] of cors) response.headers.set(name, value);
    return response;
  } catch (cause) {
    if (cause instanceof GatewayError) return cause.toResponse(cors);
    // Never let an unexpected throw surface a stack trace or the key.
    console.error("ai gateway failure", cause);
    return Response.json(
      {
        error: {
          message: "The AI gateway failed unexpectedly.",
          type: "opencut_gateway_error",
          code: "internal_error",
        },
      },
      { status: 500, headers: cors },
    );
  }
}

const route = (name: GatewayRouteName): GatewayRoute => GATEWAY_ROUTES[name];

export const ai = new Elysia({ prefix: "/ai" })
  // Preflight for the browser client. Origins come from AI_ALLOWED_ORIGINS.
  .options("/*", ({ request }) => {
    try {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers, resolveConfig(readEnv())),
      });
    } catch {
      return new Response(null, { status: 204 });
    }
  })

  // Catalogs. Public upstream, so these work before a key is configured only
  // in the sense that xKiro does not need one — this Worker still does.
  .get("/models", (ctx) => handle(route("models"), ctx))
  .get("/voices", (ctx) => handle(route("voices"), ctx))

  // Text, in whichever dialect the caller speaks.
  .post("/chat", (ctx) => handle(route("chat"), ctx))
  .post("/messages", (ctx) => handle(route("messages"), ctx))
  .post("/count-tokens", (ctx) => handle(route("count-tokens"), ctx))

  // Speech. Responds with audio bytes rather than JSON.
  .post("/speech", (ctx) => handle(route("speech"), ctx))

  // Images are a job API: POST returns 202 with an id, then poll it. A single
  // image takes tens of seconds to minutes, longer than any proxy holds a
  // connection open, which is why it is shaped this way rather than streamed.
  .post("/images", (ctx) => handle(route("images"), ctx))
  .get("/images/:id", (ctx) =>
    handle(
      { method: "GET", upstream: IMAGE_JOB_UPSTREAM },
      ctx,
      { pathSuffix: ctx.params.id },
    ),
  );
