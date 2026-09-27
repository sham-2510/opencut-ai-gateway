/**
 * xKiro reports failures in two shapes depending on dialect. Both carry a
 * stable `type` (and `code`, on the OpenAI side); the `message` is written for
 * people and gets reworded, so nothing here branches on it.
 */

export type XkiroErrorBody = {
  error: {
    message: string;
    /** Stable identifier. Branch on this, not on `message`. */
    type: string;
    /** Present in the OpenAI dialect; absent from `/v1/messages`. */
    code?: string;
  };
};

export type GatewayErrorCode =
  | "gateway_not_configured"
  | "gateway_unauthorized"
  | "path_not_allowed"
  | "model_not_allowed"
  | "invalid_request"
  | "payload_too_large"
  | "upstream_unreachable"
  | "upstream_timeout";

const STATUS_BY_CODE: Record<GatewayErrorCode, number> = {
  gateway_not_configured: 503,
  gateway_unauthorized: 401,
  path_not_allowed: 404,
  model_not_allowed: 403,
  invalid_request: 400,
  payload_too_large: 413,
  upstream_unreachable: 502,
  upstream_timeout: 504,
};

/**
 * Errors the gateway itself raises, shaped like an upstream error so a client
 * only has to understand one envelope.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  toBody(): XkiroErrorBody {
    return {
      error: {
        message: this.message,
        type: "opencut_gateway_error",
        code: this.code,
      },
    };
  }

  toResponse(extraHeaders?: HeadersInit): Response {
    return Response.json(this.toBody(), {
      status: this.status,
      headers: extraHeaders,
    });
  }
}

export function isRetryableStatus(
  status: number,
  retryable: ReadonlySet<number>,
): boolean {
  return retryable.has(status);
}

/**
 * How long to wait before the next attempt. The server knows better than any
 * formula when it told us, so `Retry-After` wins; otherwise exponential
 * backoff with jitter to avoid a thundering herd of retries.
 */
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return 2 ** attempt * 1000 + Math.random() * 300;
}
