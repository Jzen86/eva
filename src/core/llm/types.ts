/** A tool call requested by the LLM. */
export interface ToolUseRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * An opaque provider token that has to be handed back with this exact call.
   *
   * Gemini 3 attaches `thought_signature` to every function call and refuses the
   * follow-up request without it — 400, no body, and the error names a docs page
   * rather than the field we dropped. Nothing else uses it, so it is carried
   * opaquely and only echoed to the provider that issued it.
   */
  providerEcho?: Record<string, unknown>;
}

/** A content part for multimodal messages. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A single message in a chat conversation. */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** Tool calls made by the assistant (role=assistant only). */
  toolCalls?: ToolUseRequest[];
  /** ID of the tool call this message is a result for (role=tool only). */
  toolCallId?: string;
}

/** A chunk emitted during streaming. */
export interface LLMStreamChunk {
  delta: string;
  done: boolean;
}

/** A complete (non-streaming) LLM response. */
export interface LLMResponse {
  text: string;
  toolCalls?: ToolUseRequest[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: { promptTokens: number; completionTokens: number };
}

/** Tool definition in OpenAI function-calling format. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Callback receiving text chunks during streaming. */
export type StreamCallback = (chunk: string) => void;

/** Minimal client interface used by the router. */
export interface LLMClient {
  chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse>;
  /** Streaming chat — calls onChunk with each text delta, returns final response. */
  chatStream(messages: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]): Promise<LLMResponse>;
}
