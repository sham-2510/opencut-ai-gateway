import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiClient, AiError, ai as sharedClient } from "./client";
import type { ChatMessage, ChatRequest, Usage } from "./types";

export type UseChatOptions = {
  model: string;
  /** Prepended to every turn and never shown in `messages`. */
  system?: string;
  client?: AiClient;
  /** Passed through to the gateway, e.g. reasoning_effort or max_tokens. */
  params?: Omit<ChatRequest, "model" | "messages" | "stream">;
};

export type UseChatResult = {
  messages: ChatMessage[];
  /** Tokens for the in-flight assistant turn, before it lands in `messages`. */
  partial: string;
  isStreaming: boolean;
  error: AiError | Error | null;
  /** Usage for the last completed turn, when the gateway reported it. */
  usage: Usage | null;
  send: (text: string) => Promise<void>;
  /** Cancels the in-flight turn. Billing stops at the tokens already produced. */
  stop: () => void;
  reset: () => void;
};

/**
 * Minimal streaming chat state for the editor. Deliberately small: it owns the
 * transcript and the in-flight turn, and nothing else.
 */
export function useChat(options: UseChatOptions): UseChatResult {
  const { model, system, params } = options;
  const client = options.client ?? sharedClient;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partial, setPartial] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<AiError | Error | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // An unmount has to cancel too, otherwise the upstream call keeps generating
  // (and billing) for a component nobody is looking at.
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    setMessages([]);
    setPartial("");
    setError(null);
    setUsage(null);
  }, [stop]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || isStreaming) return;

      const outgoing: ChatMessage = { role: "user", content: trimmed };
      const history = [...messages, outgoing];

      setMessages(history);
      setPartial("");
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const request: ChatRequest = {
        ...params,
        model,
        messages: system
          ? [{ role: "system", content: system }, ...history]
          : history,
      };

      let assembled = "";
      try {
        for await (const event of client.streamChat(request, {
          signal: controller.signal,
        })) {
          if (event.type === "delta") {
            assembled += event.text;
            setPartial(assembled);
          } else if (event.type === "usage") {
            setUsage(event.usage);
          }
        }

        if (assembled.length > 0) {
          setMessages([...history, { role: "assistant", content: assembled }]);
        }
      } catch (cause) {
        // An abort is a user action, not a failure worth surfacing.
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
        // Keep whatever arrived before the break rather than dropping it.
        if (assembled.length > 0) {
          setMessages([...history, { role: "assistant", content: assembled }]);
        }
      } finally {
        setPartial("");
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [client, isStreaming, messages, model, params, system],
  );

  return useMemo(
    () => ({ messages, partial, isStreaming, error, usage, send, stop, reset }),
    [messages, partial, isStreaming, error, usage, send, stop, reset],
  );
}
