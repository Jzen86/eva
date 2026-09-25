import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "../types.js";

/**
 * A client for any endpoint that speaks the OpenAI chat-completions API.
 *
 * OpenRouter, OpenAI, Groq, Together, DeepSeek, Together, local servers, and the
 * official OpenAI-compatible endpoints of Anthropic and Google Gemini all work
 * here — the only thing that changes is baseURL and apiKey.
 */
export interface OpenAICompatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Extra headers. OpenRouter wants HTTP-Referer/X-Title for its rankings. */
  headers?: Record<string, string>;
  /**
   * Ask the endpoint to report token usage on streams. Some providers reject
   * the request with a 400 when this is set, so we fall back automatically.
   */
  streamUsage?: boolean;
}

/** Convert our LLMMessage[] to the OpenAI wire format. */
export function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.toolCallId!,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      };
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    // Multimodal content (text + images) — pass through as-is
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    } as OpenAI.ChatCompletionMessageParam;
  });
}

/** Parse finish_reason + tool_calls into our LLMResponse. */
export function buildResponse(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): LLMResponse {
  const stopReason =
    finishReason === "tool_calls" ? "tool_use"
    : finishReason === "stop" ? "end_turn"
    : "end_turn";

  return {
    text: content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    stopReason: toolCalls?.length ? "tool_use" : stopReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  };
}

/** A streamed tool-call delta, structurally typed so we do not depend on the
 *  SDK's internal type names, which differ between versions. */
interface ToolCallDelta {
  index?: number | null;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

export class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private lastKey: number | null = null;

  add(delta: ToolCallDelta): void {
    const isNew = Boolean(delta.id);
    let key: number;

    if (delta.index != null) {
      key = delta.index;
    } else if (isNew || this.lastKey === null) {
      key = this.calls.size;
    } else {
      key = this.lastKey;
    }

    let entry = this.calls.get(key);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      this.calls.set(key, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name = delta.function.name;
    if (delta.function?.arguments) entry.args += delta.function.arguments;
    this.lastKey = key;
  }

  /** Completed calls, in the order they were first seen. */
  finish(): Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined {
    if (this.calls.size === 0) return undefined;
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, c]) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.args || "{}") as Record<string, unknown>;
        } catch {
          // Truncated or malformed arguments — hand back an empty object rather
          // than throwing and losing the whole response.
        }
        return { id: c.id || `call_${key}`, name: c.name, arguments: args };
      });
  }
}

export function createOpenAICompatClient(opts: OpenAICompatOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
  });

  // Start optimistic, drop to false if the endpoint rejects the parameter.
  let streamUsage = opts.streamUsage ?? true;

  const wantsStreamUsageRejected = (err: unknown): boolean =>
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /stream_options|include_usage|stream usage/i.test(err.message ?? "");

  const createStream = (
    messages: LLMMessage[],
    tools: ToolDefinition[] | undefined,
  ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>> => {
    const body = {
      model: opts.model,
      messages: toOpenAIMessages(messages),
      ...(tools?.length ? { tools } : {}),
      stream: true,
      ...(streamUsage ? { stream_options: { include_usage: true } } : {}),
    } as OpenAI.ChatCompletionCreateParamsStreaming;

    return client.chat.completions
      .create(body)
      .catch((err: unknown) => {
        if (!wantsStreamUsageRejected(err)) throw err;
        streamUsage = false;
        return client.chat.completions.create({ ...body, stream_options: undefined });
      }) as Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
  };

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
      });

      const choice = res.choices[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseArgs(tc.function.arguments),
      }));

      return buildResponse(
        message?.content ?? "",
        choice?.finish_reason ?? null,
        toolCalls,
        res.usage
          ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens }
          : undefined,
      );
    },

    async chatStream(
      messages: LLMMessage[],
      onChunk: StreamCallback,
      tools?: ToolDefinition[],
    ): Promise<LLMResponse> {
      const stream = await createStream(messages, tools);

      let text = "";
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
      const acc = new ToolCallAccumulator();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta) {
          if (delta.content) {
            text += delta.content;
            onChunk(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) acc.add(tc);
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens };
        }
      }

      return buildResponse(text, finishReason, acc.finish(), usage);
    },
  };
}

function safeParseArgs(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
