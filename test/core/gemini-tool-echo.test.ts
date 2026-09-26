import { describe, it, expect } from "vitest";
import { toOpenAIMessages, ToolCallAccumulator } from "../../src/core/llm/providers/openai-compat.js";
import { echoesToolContent } from "../../src/core/llm/registry.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * The round-trip that broke tools on Gemini, found on a live install.
 *
 * The log said it plainly: turn 1 came back with a tool call, the tool ran, and
 * turn 2 — the request carrying the tool result — died with
 *
 *   400 Function call is missing a thought_signature in functionCall parts
 *
 * with no body and no field name we could act on. Gemini 3 attaches
 * `thought_signature` to every function call and requires it echoed back. We were
 * parsing the response and keeping id, name and arguments, which is everything
 * the OpenAI schema defines — and the schema is the whole problem: this token
 * lives outside it.
 *
 * The second half matters as much as the first. Sending it to everyone is not a
 * neutral default: OpenAI rejects an unrecognised field in a tool call with its
 * own 400, so a fix that attached the blob unconditionally would break every
 * other provider to repair one.
 */

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER = "https://openrouter.ai/api/v1";
const SIGNATURE = { google: { thought_signature: "EmAKXgFpFH0TVGvt" } };

/** The message array of turn 2: what she sent, and what the tool returned. */
const TURN_TWO: LLMMessage[] = [
  { role: "user", content: "Кто сейчас отвечает?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_1", name: "switch_model", arguments: { action: "providers" }, providerEcho: SIGNATURE },
    ],
  },
  { role: "tool", toolCallId: "call_1", content: "openrouter — готов" },
];

describe("toOpenAIMessages — the provider's own tool bookkeeping", () => {
  it("sends the token back to an endpoint that asked for it", () => {
    const [_, assistant] = toOpenAIMessages(TURN_TWO, { echoProviderToolContent: true });
    const call = (assistant as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
    expect(call.extra_content).toEqual(SIGNATURE);
  });

  it("withholds it from an endpoint that never sent one", () => {
    // OpenAI 400s on an unrecognised field in a tool call. Silence is the safe
    // default; the token is not ours to volunteer.
    const [_, assistant] = toOpenAIMessages(TURN_TWO);
    const call = (assistant as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
    expect(call.extra_content).toBeUndefined();
  });

  it("leaves an ordinary call untouched, whatever the flag says", () => {
    const plain: LLMMessage[] = [
      { role: "user", content: "привет" },
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "shell", arguments: {} }] },
    ];
    for (const flag of [true, false]) {
      const [, assistant] = toOpenAIMessages(plain, { echoProviderToolContent: flag });
      const call = (assistant as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
      expect(Object.keys(call).sort(), `flag=${flag}`).toEqual(["function", "id", "type"]);
    }
  });

  it("does not corrupt the rest of the message on the way", () => {
    const [user, assistant, tool] = toOpenAIMessages(TURN_TWO, { echoProviderToolContent: true });
    expect(user).toEqual({ role: "user", content: "Кто сейчас отвечает?" });
    expect((assistant as { tool_call_id?: string }).tool_call_id).toBeUndefined();
    expect(tool).toEqual({ role: "tool", tool_call_id: "call_1", content: "openrouter — готов" });
  });
});

describe("ToolCallAccumulator — the same token, in a stream", () => {
  it("keeps a signature that arrives in the opening delta", () => {
    // Google sends it in the same chunk that carries id, name and the full
    // arguments, so there is nothing to wait for and nothing to stitch.
    const acc = new ToolCallAccumulator();
    acc.add({
      id: "call_9",
      function: { name: "switch_model", arguments: '{"action":"current"}' },
      extra_content: SIGNATURE,
    });
    expect(acc.finish()?.[0].providerEcho).toEqual(SIGNATURE);
  });

  it("survives the signature arriving in a later delta than the arguments", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: "call_9", function: { name: "shell", arguments: '{"a":' } });
    acc.add({ index: 0, function: { arguments: '1}' } });
    acc.add({ index: 0, extra_content: SIGNATURE });
    const call = acc.finish()?.[0];
    expect(call?.arguments).toEqual({ a: 1 });
    expect(call?.providerEcho).toEqual(SIGNATURE);
  });

  it("reports no token at all when the provider sent none", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: "call_9", function: { name: "shell", arguments: "{}" } });
    expect(acc.finish()?.[0].providerEcho).toBeUndefined();
  });

  it("treats an empty blob as no blob", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: "call_9", function: { name: "shell", arguments: "{}" }, extra_content: {} });
    expect(acc.finish()?.[0].providerEcho).toBeUndefined();
  });
});

describe("which endpoints want it", () => {
  it("is Gemini's, and only Gemini's", () => {
    // Written as a table because the failure is a 400 with no body: whoever adds
    // the next provider has to decide here, in the open, rather than discover it
    // in production.
    for (const url of [GEMINI, `${GEMINI}/`, "https://generativelanguage.googleapis.com:443/v1beta/openai"]) {
      expect(echoesToolContent(url), url).toBe(true);
    }
    for (const url of [
      OPENROUTER,
      "https://api.openai.com/v1",
      "https://api.groq.com/openai/v1",
      "https://api.deepseek.com/v1",
      // A lookalike host must not match: the token is bearer-ish material and a
      // substring test that anyone could satisfy is not a check.
      "https://generativelanguage.googleapis.com.evil.test/v1",
      "https://notgenerativelanguage.googleapis.com/v1",
      "http://127.0.0.1:1234/v1",
    ]) {
      expect(echoesToolContent(url), url).toBe(false);
    }
  });
});
