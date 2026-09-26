import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, ToolUseRequest, StreamCallback } from "../types.js";

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
  /**
   * Send back the opaque `extra_content` a provider attached to its tool calls.
   *
   * Only Gemini 3 attaches any, and only Gemini 3 refuses a follow-up without
   * it. Sending it to anyone else is not free: OpenAI rejects an unrecognised
   * field in a tool call with a 400 of its own, so "attach it always" would
   * break the majority to fix one provider. The token is therefore stored
   * opaquely on the call and echoed only when the client knows the endpoint
   * wants it.
   */
  echoProviderToolContent?: boolean;
}

/** Convert our LLMMessage[] to the OpenAI wire format. */
export function toOpenAIMessages(
  messages: LLMMessage[],
  opts: { echoProviderToolContent?: boolean } = {},
): OpenAI.ChatCompletionMessageParam[] {
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
          // The round-trip that Gemini 3 requires. Kept last so it reads as the
          // add-on it is: the three fields above are the whole protocol, this
          // is one provider's bookkeeping.
          ...(opts.echoProviderToolContent && tc.providerEcho
            ? { extra_content: tc.providerEcho }
            : {}),
        })),
      } as OpenAI.ChatCompletionMessageParam;
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
  extra_content?: unknown;
}

export class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; args: string; echo?: Record<string, unknown> }>();
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
    // Gemini sends the signature in the same delta that opens the call, so it is
    // read once here rather than reconstructed later.
    const echo = providerToolContent(delta.extra_content);
    if (echo) entry.echo = echo;
    this.lastKey = key;
  }

  /** Completed calls, in the order they were first seen. */
  finish(): Array<ToolUseRequest> | undefined {
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
        return {
          id: c.id || `call_${key}`,
          name: c.name,
          arguments: args,
          ...(c.echo ? { providerEcho: c.echo } : {}),
        };
      });
  }
}

/**
 * The opaque blob a provider may attach to a tool call.
 *
 * Gemini 3 puts `thought_signature` there and refuses the next request without
 * it. It is kept whole and unexamined: it is a token for that provider, not
 * data of ours, and a filter that tried to understand it would one day drop the
 * field that mattered.
 */
function providerToolContent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const keys = Object.keys(raw as Record<string, unknown>);
  return keys.length > 0 ? (raw as Record<string, unknown>) : undefined;
}

/**
 * Read a response body whole, or turn a non-2xx into the SDK's own error type.
 *
 * The SDK stays the transport — retries, timeouts, connection pooling, and an
 * error class the router already knows how to read. What it cannot be is the
 * parser: it builds the response object from its own declared fields, so
 * anything a provider adds on the side never reaches us. Gemini 3 adds
 * `thought_signature` to every tool call, refuses the follow-up without it, and
 * reports the omission as a 400 with no body. So the body is read here, whole.
 */
async function readJsonOrThrow(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw await apiErrorFrom(response);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** The SDK's error, built from a response we have already read. */
async function apiErrorFrom(response: Response, bodyText?: string): Promise<Error> {
  const text = bodyText ?? (await response.text().catch(() => ""));
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON. The status is then the whole message, which is exactly what a
    // Gemini 400 with no body gives us — and better than a parse error, which
    // would hide the status the router needs to decide about a fallback.
  }
  return OpenAI.APIError.generate(
    response.status,
    parsed as unknown as object,
    parsed ? undefined : text.slice(0, 300),
    // The SDK wants headers as a plain record; a web Headers object is not one.
    Object.fromEntries(response.headers.entries()) as Record<string, string>,
  );
}

/**
 * Chunks of a response body, whichever shape the transport hands back.
 *
 * The SDK's own `asResponse()` on a streaming call does not always give a web
 * ReadableStream — on Node it has been a plain async-iterable stream — so this
 * asks for the reader and falls back rather than assuming. Incremental delivery
 * is not optional here: it is what makes her answers appear word by word in the
 * chat, and a fallback that quietly buffered the whole body would work and feel
 * broken at the same time.
 */
async function* bodyChunks(response: Response): AsyncGenerator<string> {
  const body = response.body as unknown as
    | (ReadableStream<Uint8Array> & { destroy?: () => void })
    | (AsyncIterable<Uint8Array | string> & { destroy?: () => void })
    | null;
  if (!body) return;

  const decoder = new TextDecoder();
  const toText = (chunk: Uint8Array | string): string =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield toText(value);
      }
    } finally {
      // Release *and* cancel. Releasing alone leaves the socket open when the
      // consumer stops early — which it always does, at [DONE] — and a bot that
      // answers all day would accumulate one live connection per answer. The
      // symptom is invisible for hours and then the process will not exit.
      reader.releaseLock();
      void reader.cancel().catch(() => {});
    }
    return;
  }

  const iterator = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (value !== undefined) yield toText(value);
    }
  } finally {
    await iterator.return?.(undefined as never).catch(() => {});
    body.destroy?.();
  }
}

/** Split an SSE body into parsed `data:` payloads. */
async function* ssePayloads(response: Response): AsyncGenerator<Record<string, unknown>> {
  let buffer = "";
  for await (const piece of bodyChunks(response)) {
    buffer += piece;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // A partial or non-JSON frame is not worth failing a whole answer over.
      }
    }
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

  const streamBody = (messages: LLMMessage[], tools?: ToolDefinition[]) =>
    ({
      model: opts.model,
      messages: toOpenAIMessages(messages, opts),
      ...(tools?.length ? { tools } : {}),
      stream: true,
      ...(streamUsage ? { stream_options: { include_usage: true } } : {}),
    }) as OpenAI.ChatCompletionCreateParamsStreaming;

  /**
   * Some providers 400 on `stream_options` and the fix is to drop it and ask
   * again — but only for that complaint, judged on the status and the words in
   * the body, because the SDK's typed error is no longer what the response
   * passes through.
   */
  const rejectsStreamUsage = (status: number, body: string): boolean =>
    status === 400 && /stream_options|include_usage|stream usage/i.test(body);

  const openStream = async (
    messages: LLMMessage[],
    tools?: ToolDefinition[],
  ): Promise<Response> => {
    const response = await client.chat.completions.create(streamBody(messages, tools)).asResponse();
    if (response.ok) return response;

    const text = await response.text().catch(() => "");
    if (rejectsStreamUsage(response.status, text)) {
      streamUsage = false;
      const retry = await client.chat.completions.create(streamBody(messages, tools)).asResponse();
      if (retry.ok) return retry;
      throw await apiErrorFrom(retry);
    }
    throw await apiErrorFrom(response, text);
  };

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      const response = await client.chat.completions
        .create({
          model: opts.model,
          messages: toOpenAIMessages(messages, opts),
          ...(tools?.length ? { tools } : {}),
        } as OpenAI.ChatCompletionCreateParamsNonStreaming)
        .asResponse();

      const json = (await readJsonOrThrow(response)) as {
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = json.choices?.[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc) => {
        const fn = tc.function as { name?: string; arguments?: string } | undefined;
        const echo = providerToolContent(tc.extra_content);
        return {
          id: String(tc.id ?? ""),
          name: fn?.name ?? "",
          arguments: safeParseArgs(fn?.arguments),
          ...(echo ? { providerEcho: echo } : {}),
        };
      });

      return buildResponse(
        message?.content ?? "",
        choice?.finish_reason ?? null,
        toolCalls,
        json.usage
          ? {
              prompt_tokens: json.usage.prompt_tokens ?? 0,
              completion_tokens: json.usage.completion_tokens ?? 0,
            }
          : undefined,
      );
    },

    async chatStream(
      messages: LLMMessage[],
      onChunk: StreamCallback,
      tools?: ToolDefinition[],
    ): Promise<LLMResponse> {
      const response = await openStream(messages, tools);

      let text = "";
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
      const acc = new ToolCallAccumulator();

      for await (const chunk of ssePayloads(response)) {
        const choices = chunk.choices as
          | Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>
          | undefined;
        const choice = choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            onChunk(delta.content);
          }
          const calls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          for (const tc of calls ?? []) {
            acc.add({
              index: typeof tc.index === "number" ? tc.index : null,
              id: typeof tc.id === "string" ? tc.id : null,
              function: tc.function as ToolCallDelta["function"],
              extra_content: tc.extra_content,
            });
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u) {
          usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 };
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
