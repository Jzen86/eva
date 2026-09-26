import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { saveConfig } from "../../src/core/config.js";
import type { PromptConfig } from "../../src/core/prompt.js";

/**
 * A change to who she is has to be in her next answer.
 *
 * The engine used to hold the identity it was constructed with, so a persona
 * written from the chat — `/persona`, or a `self_config` call the owner
 * confirmed with `/yes` — changed nothing until somebody restarted the bot. The
 * owner's words were «потом командами можно поменять», and the honest reading of
 * that code was «потом, после рестарта, а про рестарт не говорил никто».
 */

/** Keeps every system prompt it was asked to build, and answers without a network. */
function fakeLlm() {
  const prompts: string[] = [];
  const reply = { text: "ок", stopReason: "end_turn" };
  return {
    prompts,
    client: {
      fast: () => ({
        chat: async (messages: Array<{ role: string; content: string }>) => {
          prompts.push(String(messages.find((m) => m.role === "system")?.content ?? ""));
          return reply;
        },
      }),
      strong: () => ({ chat: async () => reply }),
    },
  };
}

const STARTUP: PromptConfig = {
  name: "Ева",
  gender: "neutral",
  personality: { persona: "собранная из ничего" },
  personalitySliders: {},
};

let dir: string;
let configPath: string;
const savedConfigPath = process.env.EVA_CONFIG_PATH;

/** A fresh install's own words, written the way the constructor writes them. */
function useConfig(config: Record<string, unknown>): void {
  saveConfig(config as never, configPath);
}

function engineWith(llm: ReturnType<typeof fakeLlm>) {
  return new Engine({
    llm: llm.client as never,
    config: STARTUP,
    tools: new ToolRegistry(),
    contextBudget: 40000,
  });
}

function say(text: string) {
  return { channelName: "test", userId: "u", text, timestamp: Date.now() };
}

function freshConfigDir(): void {
  dir = path.join(os.tmpdir(), `eva-live-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, "config.yaml");
  process.env.EVA_CONFIG_PATH = configPath;
  useConfig({ agent: { name: "Ева", gender: "neutral", personality: {} } });
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
  if (savedConfigPath === undefined) delete process.env.EVA_CONFIG_PATH;
  else process.env.EVA_CONFIG_PATH = savedConfigPath;
});

describe("live identity", () => {
  it("picks up a character written to the config, with no restart", async () => {
    freshConfigDir();
    const llm = fakeLlm();
    const engine = engineWith(llm);

    await engine.process(say("привет"));
    // The startup snapshot says she was built out of nothing; the file says she
    // has no character yet. The file is what the owner just wrote.
    expect(llm.prompts[0]).not.toContain("собранная из ничего");

    // The constructor finishes, and writes her.
    useConfig({
      agent: { name: "Ева", gender: "female", personality: { persona: "тёплая и своя" } },
    });

    await engine.process(say("ещё раз"));
    const second = llm.prompts[1];
    expect(second).toContain("тёплая и своя");
    expect(second).not.toContain("собранная из ничего");
  });

  it("picks up a name and a gender change too", async () => {
    freshConfigDir();
    useConfig({ agent: { name: "Лида", gender: "male", personality: {} } });
    const llm = fakeLlm();

    await engineWith(llm).process(say("привет"));
    expect(llm.prompts[0]).toContain("Лида");
    expect(llm.prompts[0]).toContain("Ты мужчина");
  });

  it("keeps the startup snapshot when the config has gone unreadable", async () => {
    freshConfigDir();
    const llm = fakeLlm();
    const engine = engineWith(llm);

    // A half-written file — the window between a save and its rename.
    fs.writeFileSync(configPath, "agent:\n  name: [\n");

    await engine.process(say("привет"));
    // A bot that suddenly forgets who she is because the file was briefly
    // unreadable is worse than one that is a message late.
    expect(llm.prompts[0]).toContain("собранная из ничего");
  });
});
