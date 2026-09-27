/**
 * Request and response shapes for the OpenCut AI gateway, which is a
 * pass-through to xKiro. These mirror the OpenAI Chat Completions dialect
 * because that is what the gateway's `/ai/chat` route speaks.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type TextPart = { type: "text"; text: string };

/** Base64 data URLs work as well as remote URLs. */
export type ImagePart = { type: "image_url"; image_url: { url: string } };

export type ChatContent = string | Array<TextPart | ImagePart>;

export type ChatMessage = {
  role: ChatRole;
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
};

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ChatRequest = {
  /** Full `vendor/model` ID. A bare name does not resolve. */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  /** Ignored while reasoning is active, because reasoning models reject it. */
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  response_format?: { type: "json_object" | "text" };
  reasoning_effort?: ReasoningEffort;
  tools?: unknown[];
  tool_choice?: unknown;
  /** Live search results with citations, works on models without native tools. */
  web_search?: Record<string, unknown>;
  /** Opaque end-user identifier, echoed into gateway logs. */
  user?: string;
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatChoice = {
  index: number;
  message: { role: "assistant"; content: string | null };
  finish_reason: string | null;
};

export type ChatResponse = {
  id: string;
  object: string;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
};

/**
 * One streamed frame. Note `choices` can be empty: the usage frame arrives
 * after the one carrying `finish_reason` and has no choices at all, so reading
 * `choices[0]` unconditionally will throw.
 */
export type ChatChunk = {
  id: string;
  object: "chat.completion.chunk";
  model?: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
  usage?: Usage;
};

/** What `streamChat` yields, once the wire format has been dealt with. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "finish"; reason: string }
  | { type: "usage"; usage: Usage };

export type XkiroErrorBody = {
  error: {
    message: string;
    /** Stable identifier — branch on this, never on `message`. */
    type: string;
    code?: string;
  };
};

export type ModelEntry = {
  id: string;
  object: string;
  modality?: string;
  [key: string]: unknown;
};

export type ModelList = { object: string; data: ModelEntry[] };

export type Voice = {
  id: string;
  name: string;
  locale: string | null;
  languageKey: string | null;
  gender: string | null;
  isVip: boolean;
  categories: string[];
};

export type VoiceList = { total: number; returned: number; voices: Voice[] };

export type SpeechRequest = {
  /** Speech IDs are bare, not `vendor/model`. Currently `xkiro-voice`. */
  model: string;
  /** Billed per character of this field. */
  input: string;
  voice?: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  /** 0.25–4.0, 1.0 is the natural rate. */
  speed?: number;
  pitch?: number;
  volume?: number;
  emotion?: string;
  stream?: boolean;
};

export type ImageRequest = {
  /** No account default, so this is required. */
  model: string;
  prompt: string;
  /** Currently must be 1. Each image is a separate billable unit. */
  n?: number;
  size?: string;
  style?: string;
  /** Re-render an existing job at a different aspect ratio. */
  source_job_id?: string;
};

export type ImageJob = {
  id: string;
  object: "image.generation.job";
  status: "processing" | "succeeded" | "failed";
  created: number;
  model: string;
  prompt: string;
  aspect_ratio?: string;
  style?: string | null;
  [key: string]: unknown;
};
