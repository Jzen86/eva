import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine mediaUrl propagation", () => {
  it("propagates mediaUrl from tool result to OutgoingMessage", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        return { success: true, output: "Селфи сгенерировано", mediaUrl: "https://fal.media/test.jpg" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "selfie", arguments: { context: "на пляже" } }],
      })
      .mockResolvedValueOnce({
        text: "Вот моё селфи с пляжа!",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm: llm as any, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Скинь селфи с пляжа",
      timestamp: Date.now(),
    });

    expect(res.text).toContain("селфи");
    expect(res.mediaUrl).toBe("https://fal.media/test.jpg");
  });

  it("returns no mediaUrl when tools don't produce one", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "Run shell",
      parameters: [{ name: "command", type: "string", description: "Command", required: true }],
      async execute() {
        return { success: true, output: "done" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "shell", arguments: { command: "echo hi" } }],
      })
      .mockResolvedValueOnce({
        text: "Готово",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm: llm as any, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "echo hi",
      timestamp: Date.now(),
    });

    expect(res.mediaUrl).toBeUndefined();
  });

  it("keeps the frame the turn made when the model breaks after it", async () => {
    // The catch below is a *recovery* turn, and it returned text alone: a picture
    // made before the failure — the frame she had just been told she could look at
    // — was dropped, so the owner read an apology and never saw that anything had
    // been made. `selfie` had answered "готово и отправлено" a moment earlier.
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        return { success: true, output: "Селфи сгенерировано", mediaUrl: "https://fal.media/frame.jpg" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "selfie", arguments: { context: "утро" } }],
      })
      .mockRejectedValueOnce(new Error("503 high demand"))
      .mockResolvedValueOnce({ text: "Прости, сорвалось — но кадр есть.", stopReason: "end_turn" });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await engine.process({
        channelName: "test",
        userId: "broken-turn",
        text: "скинь селфи",
        timestamp: Date.now(),
      });

      expect(res.text).toContain("сорвалось");
      expect(res.mediaUrl).toBe("https://fal.media/frame.jpg");
    } finally {
      spy.mockRestore();
    }
  });
});
