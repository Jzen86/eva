import { describe, it, expect, vi } from "vitest";
import { Engine, emptyReply } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

function mockLLM(responseText: string) {
  return {
    fast: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
    }),
    strong: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
    }),
  };
}

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine", () => {
  it("processes message and returns response", async () => {
    const engine = new Engine({ llm: mockLLM("Привет!"), config: testConfig, tools: new ToolRegistry() });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Привет",
      timestamp: Date.now(),
    });
    expect(res.text).toBe("Привет!");
  });

  it("serialises turns for one user so two flows cannot interleave", async () => {
    // The scheduler and the chat path both call process() for the same user.
    // Without a per-user lock the second builds a request from the first's
    // half-updated history — an assistant tool_call with no tool result — and
    // every provider answers 400.
    let active = 0;
    let maxActive = 0;
    const chat = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return { text: "ok", stopReason: "end_turn" };
    });
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }) };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry() });
    const msg = { channelName: "test", userId: "lock-user", text: "hi", timestamp: Date.now() };

    await Promise.all([engine.process(msg), engine.process(msg)]);

    expect(maxActive).toBe(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("moves a heavy tool turn to the strong role", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "shell",
      parameters: [],
      async execute() { return { success: true, output: "ok" }; },
    });
    const fastChat = vi.fn().mockResolvedValueOnce({
      text: "",
      stopReason: "tool_use",
      toolCalls: [{ id: "c1", name: "shell", arguments: { command: "uptime" } }],
    });
    const strongChat = vi.fn().mockResolvedValue({ text: "готово", stopReason: "end_turn" });
    const llm = {
      fast: () => ({ chat: fastChat }),
      strong: () => ({ chat: strongChat }),
      hasRole: (n: string) => n === "strong",
    };
    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "strong-user",
      text: "проверь сервер",
      timestamp: Date.now(),
    });
    expect(res.text).toBe("готово");
    expect(fastChat).toHaveBeenCalledTimes(1);
    expect(strongChat).toHaveBeenCalled();
  });

  it("keeps a light tool turn on the fast role", async () => {
    // A plain search must not drag the whole turn onto the strong model: `fast`
    // already wrote the query, and reading the results back is conversation.
    const tools = new ToolRegistry();
    tools.register({
      name: "web",
      description: "web",
      parameters: [],
      async execute() { return { success: true, output: "результаты" }; },
    });
    const fastChat = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "c1", name: "web", arguments: { action: "search", query: "мышь" } }],
      })
      .mockResolvedValueOnce({ text: "нашла", stopReason: "end_turn" });
    const strongChat = vi.fn();
    const llm = {
      fast: () => ({ chat: fastChat }),
      strong: () => ({ chat: strongChat }),
      hasRole: (n: string) => n === "strong",
    };
    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "light-user",
      text: "найди мышь",
      timestamp: Date.now(),
    });
    expect(res.text).toBe("нашла");
    expect(fastChat).toHaveBeenCalledTimes(2);
    expect(strongChat).not.toHaveBeenCalled();
  });

  it("writes the answering tier into each turn log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tiersFor = async (toolName: string, args: Record<string, unknown>) => {
      const tools = new ToolRegistry();
      tools.register({
        name: toolName,
        description: toolName,
        parameters: [],
        async execute() { return { success: true, output: "r" }; },
      });
      const fastChat = vi.fn()
        .mockResolvedValueOnce({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "c1", name: toolName, arguments: args }],
        })
        .mockResolvedValueOnce({ text: "ок", stopReason: "end_turn" });
      const strongChat = vi.fn().mockResolvedValue({ text: "ок", stopReason: "end_turn" });
      const llm = {
        fast: () => ({ chat: fastChat }),
        strong: () => ({ chat: strongChat }),
        hasRole: (n: string) => n === "strong",
      };
      const engine = new Engine({ llm, config: testConfig, tools });
      spy.mockClear();
      await engine.process({ channelName: "test", userId: `tier-${toolName}`, text: "x", timestamp: Date.now() });
      return spy.mock.calls
        .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
        .filter((o): o is { tag: string; tier: string } => Boolean(o) && o.tag === "engine")
        .map((o) => o.tier);
    };
    try {
      expect(await tiersFor("web", { action: "search" })).toEqual(["fast", "fast"]);
      expect(await tiersFor("shell", { command: "uptime" })).toEqual(["fast", "strong"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("retries once when the model answers with nothing", async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({ text: "", stopReason: "end_turn" })
      .mockResolvedValueOnce({ text: "вот ответ", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }) };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry() });
    const res = await engine.process({
      channelName: "test",
      userId: "retry-user",
      text: "привет",
      timestamp: Date.now(),
    });
    expect(res.text).toBe("вот ответ");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("never sends a bare ... when the model answers with nothing twice", async () => {
    const chat = vi.fn().mockResolvedValue({ text: "", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }) };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry() });
    const res = await engine.process({
      channelName: "test",
      userId: "empty-user",
      text: "привет",
      timestamp: Date.now(),
    });
    expect(res.text).not.toBe("...");
    expect(res.text).toMatch(/повтори, пожалуйста/);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("phrases the empty answer in the configured voice", () => {
    expect(emptyReply("female")).toMatch(/отвлеклась|прослушала|задумалась|поняла/);
    expect(emptyReply("male")).toMatch(/отвлёкся|прослушал|задумался|понял/);
    expect(emptyReply("neutral")).toMatch(/отвлекло|дошло|догоняю|убежала/);
  });

  it("names a failed service check instead of apologising for it", async () => {
    // The archive is what makes this matter. The text of a service turn is the
    // report the scheduler writes into ~/.eva/reports/<task>.md and sends as the
    // result of a check, and "прости, я прослушала" there is a lie with a date on
    // it — 13.10 10:31 server_watch did exactly that while no check had run. The
    // personal filler is right for a conversation and wrong here.
    const chat = vi.fn().mockResolvedValue({ text: "", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }) };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry() });
    const res = await engine.process({
      channelName: "test",
      userId: "empty-service",
      text: "плановая проверка",
      timestamp: Date.now(),
      metadata: { scheduledTask: true },
    });

    expect(res.text).toContain("без ответа");
    expect(res.text).not.toMatch(/прослушала|отвлеклась|задумалась|повтори/);
  });

  it("runs a check on its own role, and does not lift it to strong", async () => {
    // A check's whole job is heavy: it runs `shell` on its first turn and keeps
    // running it. So the ordinary lift would hand every check to `strong` and
    // the dedicated role would never be used — which is the point of having one:
    // the work is narrow (read a log, read a diff, write a report), not a
    // conversation.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const tools = new ToolRegistry();
      tools.register({
        name: "shell",
        description: "shell",
        parameters: [],
        async execute() { return { success: true, output: "ok" }; },
      });
      const checksChat = vi.fn()
        .mockResolvedValueOnce({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "uptime" } }],
        })
        .mockResolvedValueOnce({ text: "отчёт", stopReason: "end_turn" });
      const fastChat = vi.fn().mockResolvedValue({ text: "чат", stopReason: "end_turn" });
      const strongChat = vi.fn().mockResolvedValue({ text: "сильный", stopReason: "end_turn" });
      const llm = {
        fast: () => ({ chat: fastChat }),
        strong: () => ({ chat: strongChat }),
        proxied: (name: string) => (name === "checks" ? { chat: checksChat } : { chat: strongChat }),
        hasRole: (n: string) => n === "strong" || n === "checks",
      };
      const engine = new Engine({ llm, config: testConfig, tools });
      const res = await engine.process({
        channelName: "test",
        userId: "checks-user",
        text: "обход сервера",
        timestamp: Date.now(),
        metadata: { scheduledTask: true, reportTask: true },
      });

      expect(res.text).toBe("отчёт");
      expect(checksChat).toHaveBeenCalledTimes(2);
      expect(strongChat).not.toHaveBeenCalled();
      expect(fastChat).not.toHaveBeenCalled();
      // And the journal says which role answered, so "почему это стоило столько"
      // is answerable from the log alone.
      const tiers = spy.mock.calls
        .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
        .filter((o): o is { tag: string; tier: string } => Boolean(o) && o.tag === "engine")
        .map((o) => o.tier);
      expect(tiers).toEqual(["checks", "checks"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a one-shot scheduled message on the usual roles", async () => {
    // A reminder is not a check: it is her voice in a message, so it runs where
    // a conversation runs. The scheduler marks the difference (`reportTask`).
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "shell",
      parameters: [],
      async execute() { return { success: true, output: "ok" }; },
    });
    const checksChat = vi.fn().mockResolvedValue({ text: "отчёт", stopReason: "end_turn" });
    const fastChat = vi.fn().mockResolvedValue({ text: "доброе утро", stopReason: "end_turn" });
    const llm = {
      fast: () => ({ chat: fastChat }),
      strong: () => ({ chat: fastChat }),
      proxied: () => ({ chat: checksChat }),
      hasRole: () => true,
    };
    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "reminder-user",
      text: "будильник",
      timestamp: Date.now(),
      metadata: { scheduledTask: true, reportTask: false },
    });

    expect(res.text).toBe("доброе утро");
    expect(checksChat).not.toHaveBeenCalled();
  });

  it("handles LLM errors gracefully", async () => {
    const llm = {
      fast: () => ({
        chat: vi.fn().mockRejectedValue(new Error("API down")),
      }),
      strong: () => ({ chat: vi.fn() }),
    };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry() });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Hello",
      timestamp: Date.now(),
    });
    // Engine returns a friendly natural-language fallback (no raw error exposed)
    expect(res.text).toBeTruthy();
    expect(res.text).not.toContain("API down");
  });

  it("executes tool calls in agentic loop", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "test_tool",
      description: "A test tool",
      parameters: [{ name: "input", type: "string", description: "Input value", required: true }],
      async execute(params) {
        return { success: true, output: `Got: ${params.input}` };
      },
    });

    // First call: LLM requests a tool, second call: LLM responds with text
    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "test_tool", arguments: { input: "hello" } }],
      })
      .mockResolvedValueOnce({
        text: "Результат: Got: hello",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Use the test tool",
      timestamp: Date.now(),
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(res.text).toContain("Got: hello");
  });
});
