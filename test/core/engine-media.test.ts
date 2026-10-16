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

  it("shows her the frame but asks for her own words, not a review of the picture", async () => {
    // The owner, 16.10: he sees the frame himself, so the caption must be her own
    // message ("я тебе кофе сделала, идём пить"), not a description of the picture
    // and not "оставлять или переделывать?". The frame still travels back to her,
    // and the note still says she sees it — that clause once stopped her from
    // writing "я не вижу картинок" into memory.
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        // A 1x1 PNG, under the preview size cap, so no ffmpeg runs in the test.
        const px =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        return { success: true, output: "Селфи отправлено в чат", mediaUrl: `data:image/png;base64,${px}` };
      },
    });

    const calls: unknown[][] = [];
    const chatMock = vi.fn()
      .mockImplementationOnce(async () => ({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "selfie", arguments: { context: "утро, кофе" } }],
      }))
      .mockImplementationOnce(async (messages: unknown[]) => {
        calls.push(messages);
        return { text: "Я тебе кофе сделала, идём пить ☕", stopReason: "end_turn" };
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "frame-caption",
      text: "скинь селфи",
      timestamp: Date.now(),
    });

    const frameMsg = (calls[0]! as any[]).find(
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
    );
    expect(frameMsg, "the frame still goes back to her as an image").toBeTruthy();
    const note = frameMsg.content.find((p: any) => p.type === "text").text as string;
    expect(note).toContain("ты видишь его сама");
    expect(note).toMatch(/не описывай/i);
    expect(note).not.toContain("Переделывать или нет");
    expect(res.text).toContain("кофе");
    expect(String(res.mediaUrl)).toContain("data:image/png");
  });

  it("sends only the accepted frame when the same generator makes a redo", async () => {
    // A gross defect is hers to redo (IMAGE_FEEDBACK_NOTE), and she does it
    // silently: the owner gets the picture, not the process. So the second inline
    // frame from the same generator replaces the rejected one in `media` instead
    // of joining it. Two *different* media (a voice and a picture) still both
    // travel — only a frame she can see and judge is redoable.
    const tools = new ToolRegistry();
    let made = 0;
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        made += 1;
        return { success: true, output: `Селфи №${made}`, mediaUrl: `data:image/png;base64,FRAME${made}` };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "c1", name: "selfie", arguments: { context: "первый" } }],
      })
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "c2", name: "selfie", arguments: { context: "переделка" } }],
      })
      .mockResolvedValueOnce({ text: "Я тебе кофе сделала, идём пить", stopReason: "end_turn" });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "redo",
      text: "скинь селфи",
      timestamp: Date.now(),
    });

    // Two frames were made; one is delivered — the second, the accepted one.
    expect(res.media?.length).toBe(1);
    expect(res.media?.[0]?.url).toContain("FRAME2");
    expect(String(res.mediaUrl)).toContain("FRAME2");
  });
});
