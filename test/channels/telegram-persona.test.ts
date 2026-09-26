import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { registerHandlers } from "../../src/channels/telegram/handlers.js";
import { loadConfig } from "../../src/core/config.js";

/**
 * The constructor as the owner meets it: commands, answers, and the messages in
 * between that must not be eaten.
 *
 * The state machine is tested in persona-quest.test.ts. What is untested there
 * is the part that can take a real message away from the owner — which listener
 * runs first, whether a quest survives a stray photo, whether an abandoned one
 * lets go. Those failures do not crash; they are discovered as «она вдруг
 * переспросила, о чём я её два часа назад», which you only hear about once.
 */

type Mw = (ctx: any, next: () => Promise<void>) => Promise<void>;

const OWNER = 4242;

/** A grammY Bot that records its middleware and can be fired by hand. */
function fakeBot(owner: number | null = OWNER) {
  const use: Mw[] = [];
  const commands = new Map<string, Mw>();
  const events = new Map<string, Mw>();
  const bot = {
    token: "TEST:token",
    api: stubApi(),
    use(fn: Mw) { use.push(fn); },
    command(name: string, fn: Mw) { commands.set(name, fn); },
    on(event: string, fn: Mw) { events.set(event, fn); },
    /** Run the owner filter, then the handler, the way grammY would. */
    async fire(name: "command" | "text" | "photo", ctx: any) {
      const handler =
        name === "command"
          ? commands.get(String(ctx.message.text).split(" ")[0].slice(1))
          : name === "text"
            ? events.get("message:text")
            : events.get("message:photo");
      let i = 0;
      const next = async (): Promise<void> => {
        const fn = use[i++];
        if (fn) return fn(ctx, next);
        if (handler) return handler(ctx, async () => {});
      };
      await next();
    },
  };
  return bot;
}

function stubApi() {
  return {
    getFile: vi.fn(async () => ({ file_path: "photos/file_1.jpg" })),
    editMessageText: vi.fn(async () => ({})),
    deleteMessage: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    raw: { sendMessageDraft: vi.fn(async () => ({})) },
  };
}

/** Everything the bot said, in order. On a phone this is the whole interface. */
let said: string[] = [];

function reply(body: string) {
  said.push(body);
  return Promise.resolve({ message_id: said.length + 1 });
}

function asOwner(text: string) {
  return {
    chat: { id: OWNER },
    from: { id: OWNER },
    message: { message_id: said.length + 1, date: 0, text },
    reply: vi.fn(reply),
    replyWithChatAction: vi.fn(async () => true),
    api: stubApi(),
  } as any;
}

function asPhoto(caption?: string) {
  return {
    chat: { id: OWNER },
    from: { id: OWNER },
    message: {
      message_id: said.length + 1,
      date: 0,
      photo: [{ file_id: "f1", file_unique_id: "u1", width: 1, height: 1 }],
      caption,
    },
    reply: vi.fn(reply),
    replyWithChatAction: vi.fn(async () => true),
    api: stubApi(),
  } as any;
}

const LLM = vi.fn(async () => ({ text: "ладно" } as any));

let dir: string;
let configPath: string;
const savedEnv = process.env.EVA_CONFIG_PATH;

beforeEach(() => {
  said = [];
  LLM.mockClear();
  dir = path.join(os.tmpdir(), `eva-quest-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, "config.yaml");
  process.env.EVA_CONFIG_PATH = configPath;
  fs.writeFileSync(
    configPath,
    "agent:\n  name: Ева\n  gender: neutral\n  personality: {}\ntelegram:\n  token: TEST:token\n",
  );
  // The photo step fetches the file from Telegram. Nothing goes over the wire.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.EVA_CONFIG_PATH;
  else process.env.EVA_CONFIG_PATH = savedEnv;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A bot on a fresh install, with nobody inside. */
function wire() {
  const bot = fakeBot();
  registerHandlers(bot as any, LLM as any, OWNER);
  return bot;
}

const personaOf = () => loadConfig(configPath)?.agent?.personality;

describe("the constructor, wired into the chat", () => {
  it("asks four questions and then writes the person", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    expect(said.at(-1)).toMatch(/фото/i);

    await bot.fire("photo", asPhoto());
    await bot.fire("text", asOwner("female"));
    await bot.fire("text", asOwner("молчаливая, наблюдательная, сначала смотрит"));
    await bot.fire("text", asOwner("на «ты», коротко, без списков"));

    const cfg = loadConfig(configPath)!;
    expect(cfg.agent?.gender).toBe("female");
    expect(cfg.agent?.personality?.persona).toBe("молчаливая, наблюдательная, сначала смотрит");
    expect(cfg.agent?.personality?.ops).toEqual(["на «ты», коротко, без списков"]);
    expect(fs.existsSync(path.join(dir, "reference.jpg"))).toBe(true);
    expect(said.at(-1)).toContain("Готово");
  });

  it("keeps a constructor answer out of the chat", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    await bot.fire("text", asOwner("она своя, но тёплая"));
    // The sentence went into the character, not into a chat turn.
    expect(LLM).not.toHaveBeenCalled();
  });

  it("hands the messages back to the LLM once the constructor is done", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    for (const skip of ["пропустить", "пропустить", "пропустить", "пропустить"]) {
      await bot.fire("text", asOwner(skip));
    }
    LLM.mockClear();
    await bot.fire("text", asOwner("привет"));
    expect(LLM).toHaveBeenCalled();
  });

  it("keeps a photo sent at the wrong question, and names the open one", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    await bot.fire("text", asOwner("пропустить")); // photo step skipped
    await bot.fire("photo", asPhoto());
    expect(said.at(-1)).toMatch(/не про фото|текстом/i);

    // The quest is intact: the next text answer is the gender one.
    await bot.fire("text", asOwner("она"));
    // And nothing is written yet. A constructor abandoned two questions from the
    // end must not leave half a person behind — she is saved whole or not at
    // all, which is also why /cancel writes nothing.
    expect(personaOf()?.persona).toBeUndefined();

    await bot.fire("text", asOwner("она своя, тёплая"));
    await bot.fire("text", asOwner("коротко, на ты"));
    expect(loadConfig(configPath)?.agent?.gender).toBe("female");
    expect(personaOf()?.persona).toBe("она своя, тёплая");
  });

  it("lets go of a constructor the owner walked away from", async () => {
    vi.useFakeTimers();
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    vi.advanceTimersByTime(16 * 60 * 1000);
    await bot.fire("text", asOwner("привет"));
    expect(said.at(-1)).toContain("/persona");
    LLM.mockClear();
    await bot.fire("text", asOwner("привет"));
    expect(LLM).toHaveBeenCalled();
  });

  it("/cancel throws the half-built person away and writes nothing", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    await bot.fire("text", asOwner("она своя и тёплая"));
    await bot.fire("command", asOwner("/cancel"));
    expect(personaOf()?.persona).toBeUndefined();
  });

  it("says who is being rebuilt, rather than asking the first question again", async () => {
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    await bot.fire("command", asOwner("/persona"));
    // The open question is repeated — the owner may have lost the thread — but
    // the opener is not, so a second /persona cannot be mistaken for a restart
    // that quietly dropped the answers already given.
    expect(said.at(-1)).toMatch(/уже собираем|сейчас спрашиваю/i);
    expect(said.filter((s) => /Соберём её заново/.test(s))).toHaveLength(1);
  });

  it("warns before a rebuild replaces a character that already exists", async () => {
    fs.writeFileSync(
      configPath,
      "agent:\n  name: Ева\n  gender: female\n  personality:\n    persona: старая, своя\ntelegram:\n  token: TEST:token\n",
    );
    const bot = wire();
    await bot.fire("command", asOwner("/persona"));
    expect(said.at(-1)).toMatch(/уже есть характер/i);
  });

  it("keeps a stranger out of somebody else's constructor", async () => {
    const bot = fakeBot(999); // the owner is somebody else
    registerHandlers(bot as any, LLM as any, 999);
    const intruder = { ...asOwner("/persona"), chat: { id: 1 } };
    await bot.fire("command", intruder);
    expect(personaOf()?.persona).toBeUndefined();
  });
});
