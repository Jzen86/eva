import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runInit, minimalConfig, PRESET_IDS, nextSteps, InitCancelled, type InitAnswers } from "../../src/core/init.js";
import { loadConfig, getLLMApiKey } from "../../src/core/config.js";

/**
 * The install path, tested.
 *
 * "Поставил командой на сервак, создал бота, подключил и пользуешься" is a claim
 * about this file. Every test here is one way that claim was false at some
 * point: a secret echoed to the terminal, a working config silently replaced, a
 * key written into a file the other users on the box can read, a prompt that
 * never fires because a default was applied too early.
 */

const TOKEN = "123456789:AAF-fake-token-value";
const KEY = "sk-fake-provider-key-0000";

function answers(over: Partial<InitAnswers> = {}): InitAnswers {
  return {
    telegramToken: TOKEN,
    providerId: "openai",
    providerKey: KEY,
    model: "gpt-4o-mini",
    agentName: "Ева",
    securityKey: "fixed-for-tests",
    silent: true,
    ...over,
  };
}

describe("minimalConfig", () => {
  it("describes a bot that can answer with nothing but a token and a key", () => {
    const cfg = minimalConfig(answers());
    expect(cfg.telegram?.token).toBe(TOKEN);
    expect(getLLMApiKey(cfg)).toBe(KEY);
    expect(cfg.models?.fast).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(cfg.models?.strong).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(cfg.providers?.openai?.base_url).toBe("https://api.openai.com/v1");
  });

  it("carries a personality, because a companion with no character is a search box", () => {
    const personality = minimalConfig(answers()).agent?.personality as Record<string, unknown>;
    expect(String(personality.persona).length).toBeGreaterThan(40);
    expect(Array.isArray(personality.ops)).toBe(true);
  });

  it("leaves the owner id for the bot to learn on first message", () => {
    expect(minimalConfig(answers()).telegram?.owner_id).toBe(0);
  });

  it("encrypts with a key of its own, not one derived from the token", () => {
    // Rotating a bot token is routine. If the http tool's key came from it,
    // rotating would quietly unlock everything it had stored.
    const a = minimalConfig(answers({ securityKey: undefined }));
    const b = minimalConfig(answers({ securityKey: undefined }));
    expect(a.security?.password_hash).not.toBe(b.security?.password_hash);
    expect(a.security?.password_hash).not.toContain(TOKEN.slice(-16));
  });

  it("uses an explicit endpoint for a provider it has never heard of", () => {
    const cfg = minimalConfig(answers({ providerId: "my-llm", baseUrl: "http://10.0.0.5:8080/v1" }));
    expect(cfg.providers?.["my-llm"]?.base_url).toBe("http://10.0.0.5:8080/v1");
  });

  it("offers only presets that already know their own endpoint", () => {
    // `openai_compatible` means "some other host" — listing it next to a model
    // question produces a config that cannot work.
    expect(PRESET_IDS).not.toContain("openai_compatible");
    expect(PRESET_IDS).toEqual(expect.arrayContaining(["openai", "openrouter", "google"]));
  });
});

describe("runInit", () => {
  let dir: string;
  let configPath: string;
  let said: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `eva-init-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    configPath = path.join(dir, "config.yaml");
    said = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], opts: Parameters<typeof runInit>[1] = {}) =>
    runInit(argv, { configPath, verify: false, ...opts });

  it("writes a config that loads back and is usable", async () => {
    const result = await run([
      "--token", TOKEN, "--provider", "openai", "--key", KEY, "--model", "gpt-4o-mini",
    ]);
    expect(result.alreadyDone).toBe(false);
    const reloaded = loadConfig(configPath);
    expect(reloaded?.telegram?.token).toBe(TOKEN);
    expect(getLLMApiKey(reloaded!)).toBe(KEY);
  });

  it("never prints the token or the key", async () => {
    await run(["--token", TOKEN, "--provider", "openai", "--key", KEY, "--model", "m"]);
    const output = said.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(KEY);
  });

  it("asks nothing when both secrets come as flags", async () => {
    const askImpl = vi.fn(async () => "x");
    const askHiddenImpl = vi.fn(async () => "x");
    await run(["--token", TOKEN, "--key", KEY, "--model", "m", "--provider", "openai"], {
      askImpl,
      askHiddenImpl,
    });
    expect(askImpl).not.toHaveBeenCalled();
    expect(askHiddenImpl).not.toHaveBeenCalled();
  });

  it("hides the two secrets and shows the rest", async () => {
    const askImpl = vi.fn(async (_q: string, fb?: string) => fb ?? "x");
    const askHiddenImpl = vi.fn(async () => "typed-secret");
    await run([], { askImpl, askHiddenImpl });
    // The token and the provider key are the two things that must not appear on
    // someone's shoulder. Everything else is a choice, not a secret.
    expect(askHiddenImpl).toHaveBeenCalledTimes(2);
    expect(askImpl).toHaveBeenCalled();
  });

  it("actually asks the name, rather than silently defaulting it", async () => {
    // The default was applied before the interactive block, which made this
    // prompt unreachable — the one question that gives the bot a personality.
    const askImpl = vi.fn(async (_q: string, fb?: string) => fb ?? "x");
    await run([], { askImpl, askHiddenImpl: async () => "s" });
    expect(askImpl.mock.calls[0]?.[0]).toContain("зовут");
  });

  it("refuses a keyless install instead of writing a broken one", async () => {
    await expect(run(["--token", TOKEN, "--key", ""])).rejects.toThrow(/ключ/i);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("refuses a model-less install", async () => {
    await expect(run(["--token", TOKEN, "--key", KEY, "--model", ""])).rejects.toThrow(/модел/i);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("treats an empty token as a cancellation, not a config", async () => {
    await expect(run(["--token", "", "--key", KEY, "--model", "m"])).rejects.toThrow(InitCancelled);
  });

  it("refuses a provider it does not know unless given an endpoint", async () => {
    await expect(run(["--token", TOKEN, "--key", KEY, "--model", "m", "--provider", "nope"]))
      .rejects.toThrow(/base-url/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("keeps a working config when init is run again", async () => {
    await run(["--token", TOKEN, "--key", KEY, "--model", "m", "--provider", "openai"]);
    fs.writeFileSync(path.join(dir, "marker"), "x");
    const before = fs.readFileSync(configPath, "utf8");

    const result = await run([]);
    expect(result.alreadyDone).toBe(true);
    // Someone runs init again while confused. Overwriting a working bot to
    // answer that question is the worst available response.
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(said.join("\n")).toContain("--force");
  });

  it("keeps the old config as a backup when forced", async () => {
    await run(["--token", TOKEN, "--key", KEY, "--model", "m", "--provider", "openai"]);
    const before = fs.readFileSync(configPath, "utf8");

    const result = await run(["--token", "999:NEW", "--key", "NEW", "--model", "m2", "--provider", "openai", "--force"]);
    expect(result.alreadyDone).toBe(false);
    expect(fs.readFileSync(`${configPath}.init-backup`, "utf8")).toBe(before);
    expect(loadConfig(configPath)?.telegram?.token).toBe("999:NEW");
  });

  it("keeps the config readable only by its owner", async (ctx) => {
    if (process.platform === "win32" || ctx.skip) return;
    await run(["--token", TOKEN, "--key", KEY, "--model", "m", "--provider", "openai"]);
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("says where to go next, including the check", () => {
    // init and README have to agree, so the steps live in code and both read
    // them from here.
    expect(nextSteps().join(" ")).toContain("eva doctor");
  });
});
