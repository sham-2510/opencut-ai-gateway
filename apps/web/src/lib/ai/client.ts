import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ImageJob,
  ImageRequest,
  ModelList,
  SpeechRequest,
  VoiceList,
  XkiroErrorBody,
} from "./types";

/**
 * Client for the OpenCut AI gateway (`apps/api`, routes under `/ai`).
 *
 * It never sees an xKiro key. The key lives on the Worker, because anything
 * running on a user's device can be read by that user.
 */

const DEFAULT_BASE_URL = "http://localhost:8787";

export type AiClientOptions = {
  /** Gateway origin. Defaults to VITE_API_URL, then localhost:8787. */
  baseUrl?: string;
  /**
   * Shared secret for the gateway. Only pass this from server-side code —
   * shipping it to a browser bundle makes it readable by every visitor.
   */
  token?: string;
  fetch?: typeof globalThis.fetch;
};

export class AiError extends Error {
  readonly status: number;
  /** Stable identifier from the gateway or xKiro. Branch on this. */
  readonly type: string;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: {
    status: number;
    type: string;
    code?: string;
    message: string;
    retryAfterMs?: number;
  }) {
    super(init.message);
    this.name = "AiError";
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
  }

  /**
   * Capacity and timing problems, where the same request can succeed shortly.
   * 400/401/403/404 are about the request itself and never become valid; 402
   * means out of credit, which no retry can fix.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class AiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: AiClientOptions = {}) {
    const configured =
      options.baseUrl ??
      (import.meta.env.VITE_API_URL as string | undefined) ??
      DEFAULT_BASE_URL;
    this.baseUrl = configured.replace(/\/+$/, "");
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.token) headers.set("x-opencut-ai-token", this.token);
    return headers;
  }

  private async request(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, ...rest } = init;
    const headers = this.headers(rest.headers);
    if (json !== undefined) headers.set("content-type", "application/json");

    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers,
      body: json === undefined ? rest.body : JSON.stringify(json),
    });

    if (!response.ok) throw await toAiError(response);
    return response;
  }

  /** Chat model catalog. Pass `modality=image`, `tts` or `all` to widen it. */
  async listModels(query?: Record<string, string>): Promise<ModelList> {
    const search = query ? `?${new URLSearchParams(query)}` : "";
    const response = await this.request(`/ai/models${search}`);
    return (await response.json()) as ModelList;
  }

  async listVoices(query?: Record<string, string>): Promise<VoiceList> {
    const search = query ? `?${new URLSearchParams(query)}` : "";
    const response = await this.request(`/ai/voices${search}`);
    return (await response.json()) as VoiceList;
  }

  /**
   * One blocking completion. Upstream cuts these off at 95 seconds, so use
   * `streamChat` for reasoning models on large prompts and for anything a
   * person is watching.
   */
  async chat(
    request: ChatRequest,
    init?: { signal?: AbortSignal },
  ): Promise<ChatResponse> {
    const response = await this.request("/ai/chat", {
      method: "POST",
      json: { ...request, stream: false },
      signal: init?.signal,
    });
    return (await response.json()) as ChatResponse;
  }

  /**
   * Streamed completion. Aborting the signal closes the connection, which
   * aborts the upstream call — you are billed for what was generated, not for
   * the whole answer.
   */
  async *streamChat(
    request: ChatRequest,
    init?: { signal?: AbortSignal },
  ): AsyncGenerator<ChatStreamEvent> {
    const response = await this.request("/ai/chat", {
      method: "POST",
      json: { ...request, stream: true },
      headers: { accept: "text/event-stream" },
      signal: init?.signal,
    });

    if (!response.body) {
      throw new AiError({
        status: 502,
        type: "opencut_gateway_error",
        code: "empty_stream",
        message: "The gateway returned no response body.",
      });
    }

    for await (const payload of readSseData(response.body)) {
      if (payload === "[DONE]") return;

      const chunk = JSON.parse(payload) as ChatChunk;

      // The usage frame arrives after the finish_reason frame and carries an
      // empty choices array, so this has to be checked before touching it.
      if (chunk.usage) {
        yield { type: "usage", usage: chunk.usage };
        continue;
      }

      const choice = chunk.choices.at(0);
      if (!choice) continue;

      if (choice.delta.content) {
        yield { type: "delta", text: choice.delta.content };
      }
      if (choice.finish_reason) {
        yield { type: "finish", reason: choice.finish_reason };
      }
    }
  }

  /** Collects a streamed completion into one string. */
  async streamChatToText(
    request: ChatRequest,
    init?: { signal?: AbortSignal; onDelta?: (text: string) => void },
  ): Promise<string> {
    let text = "";
    for await (const event of this.streamChat(request, { signal: init?.signal })) {
      if (event.type === "delta") {
        text += event.text;
        init?.onDelta?.(event.text);
      }
    }
    return text;
  }

  /** Text to speech. Resolves to audio bytes, not JSON. Billed per character. */
  async speech(
    request: SpeechRequest,
    init?: { signal?: AbortSignal },
  ): Promise<Blob> {
    const response = await this.request("/ai/speech", {
      method: "POST",
      json: request,
      signal: init?.signal,
    });
    return await response.blob();
  }

  /** Queues an image job. Resolves as soon as the job is accepted, not drawn. */
  async createImage(
    request: ImageRequest,
    init?: { signal?: AbortSignal },
  ): Promise<ImageJob> {
    const response = await this.request("/ai/images", {
      method: "POST",
      json: request,
      signal: init?.signal,
    });
    return (await response.json()) as ImageJob;
  }

  async getImageJob(id: string, init?: { signal?: AbortSignal }): Promise<ImageJob> {
    const response = await this.request(`/ai/images/${encodeURIComponent(id)}`, {
      signal: init?.signal,
    });
    return (await response.json()) as ImageJob;
  }
}

/**
 * Reads an SSE body and yields the payload of each complete `data:` line.
 *
 * A network read can land mid-event, so the tail is buffered and only whole
 * events are handed on. Parsing half of one throws.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; normalise CRLF on the way.
      const events = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const payload = dataOf(event);
        if (payload !== null) yield payload;
      }
    }

    const trailing = dataOf(buffer.replace(/\r\n/g, "\n"));
    if (trailing !== null) yield trailing;
  } finally {
    // Cancelling here is what tells the server to stop generating.
    await reader.cancel().catch(() => undefined);
  }
}

/** Joins the `data:` lines of one event, ignoring comments and other fields. */
function dataOf(event: string): string | null {
  const lines = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  return lines.length > 0 ? lines.join("\n") : null;
}

async function toAiError(response: Response): Promise<AiError> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;

  let body: XkiroErrorBody | null = null;
  try {
    body = (await response.json()) as XkiroErrorBody;
  } catch {
    body = null;
  }

  return new AiError({
    status: response.status,
    type: body?.error?.type ?? "http_error",
    code: body?.error?.code,
    message: body?.error?.message ?? `Request failed with ${response.status}.`,
    retryAfterMs,
  });
}

/** Shared instance for app code that does not need custom options. */
export const ai = new AiClient();
