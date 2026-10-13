import { describe, it, expect, vi } from "vitest";
import {
  Engine,
  MAX_PROMPT_TOKENS,
  MAX_SAME_TOOL,
  MAX_SAME_TOOL_SERVICE,
} from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

/** A turn that runs one shell command and has nothing to say yet. */
function shellTurn() {
  return {
    text: "",
    stopReason: "tool_use",
    toolCalls: [{ id: "c", name: "shell", arguments: { command: "uptime" } }],
  };
}

/**
 * The shape of a watch job: the model keeps reaching for the log, the diff and
 * the sources, one `shell` command per turn, and would finish on the seventh.
 *
 * Seven because that is where the live report was cut — on 13.10 `self_watch`
 * stopped at its sixth `shell` call and the report ended with "про Задрота не
 * успела — на меня свалился лимит на команды".
 */
async function runTurn(userId: string, metadata?: Record<string, unknown>) {
  let executed = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "shell",
    description: "shell",
    parameters: [],
    async execute() {
      executed += 1;
      return { success: true, output: "ok" };
    },
  });
  const chat = vi.fn();
  for (let i = 0; i < 7; i++) chat.mockResolvedValueOnce(shellTurn());
  chat.mockResolvedValue({ text: "готово", stopReason: "end_turn" });
  const llm = {
    fast: () => ({ chat }),
    strong: () => ({ chat }),
    hasRole: (n: string) => n === "strong",
  };
  const engine = new Engine({ llm, config: testConfig, tools });
  const res = await engine.process({
    channelName: "test",
    userId,
    text: "проверь себя",
    timestamp: Date.now(),
    ...(metadata ? { metadata } : {}),
  });
  return { res, executed };
}

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined", () => {
    expect(MAX_PROMPT_TOKENS).toBe(128_000);
  });

  it("MAX_SAME_TOOL is defined as 5", () => {
    expect(MAX_SAME_TOOL).toBe(5);
  });

  it("winds up a chat turn at the sixth call of one tool", async () => {
    // The ceiling is there for a loop, and six is one past it: five is the
    // budget, the sixth call is what trips the check.
    const { res, executed } = await runTurn("limits-chat");
    expect(executed).toBe(MAX_SAME_TOOL + 1);
    expect(res.text).toContain("использован 6 раз");
  });

  it("lets a service turn finish the job it was sent to do", async () => {
    // Same seven calls, and this one is a report nobody can ask again for: it
    // has to get through the work its own task text describes.
    const { res, executed } = await runTurn("limits-service", { scheduledTask: true });
    expect(executed).toBe(7);
    expect(executed).toBeGreaterThan(MAX_SAME_TOOL + 1);
    expect(res.text).toBe("готово");
  });

  it("keeps the service ceiling above the chat one", () => {
    expect(MAX_SAME_TOOL_SERVICE).toBeGreaterThan(MAX_SAME_TOOL);
  });
});
