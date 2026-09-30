import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  saveMessage,
  previousLiveMessage,
  saveSummaryChunk,
  loadSummary,
  SCHEDULED_TURN_PREFIX,
} from "../../src/core/memory/conversations.js";
import { gapFacts, humanGap, dayPart, relativeAge } from "../../src/core/memory/time-words.js";
import { buildSystemPrompt, type GapNotice } from "../../src/core/prompt.js";
import { saveConfig } from "../../src/core/config.js";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

/** The real silence from the live log: 29.09 20:16 → 30.09 17:42, UTC+4. */
const LIVE_FROM = Date.UTC(2026, 8, 29, 16, 16) / 1000;
const LIVE_TO = Date.UTC(2026, 8, 30, 13, 42) / 1000;

describe("humanGap", () => {
  it("says a distance the way a person would, not the way a stopwatch does", () => {
    expect(humanGap(30)).toBe("минуту");
    expect(humanGap(10 * 60)).toBe("10 минут");
    expect(humanGap(25 * 60)).toBe("полчаса");
    expect(humanGap(45 * 60)).toBe("час");
    expect(humanGap(2 * 3600)).toBe("около двух часов");
    expect(humanGap(3 * 3600)).toBe("часа три");
    expect(humanGap(5 * 3600)).toBe("часов пять");
    expect(humanGap(11 * 3600)).toBe("полдня");
    expect(humanGap(30 * 3600)).toBe("сутки");
    expect(humanGap(48 * 3600)).toBe("двое суток");
    expect(humanGap(4 * 86400)).toBe("4 дня");
    expect(humanGap(8 * 86400)).toBe("неделю");
    expect(humanGap(21 * 86400)).toBe("3 недели");
    expect(humanGap(90 * 86400)).toBe("3 месяца");
  });

  it("calls the pause from the live log 'почти сутки', not '21 час'", () => {
    // The whole point of the rounding: "21 час 26 минут" is a reading, and a
    // reading is what turns her into a clock. She has to be able to say
    // "ты пропал почти на сутки" — that is the sentence the feature is for.
    expect(humanGap(LIVE_TO - LIVE_FROM)).toBe("почти сутки");
    expect(humanGap(LIVE_TO - LIVE_FROM)).not.toMatch(/\d+:\d+|21/);
  });
});

describe("gapFacts", () => {
  it("sees that the night passed, which is the difference between 'пропал' and 'спал'", () => {
    const facts = gapFacts(LIVE_FROM, LIVE_TO, 4);
    expect(facts.label).toBe("почти сутки");
    expect(facts.crossedDay).toBe(true);
    expect(facts.touchedNight).toBe(true);
    expect(facts.fromDate).toBe("29.09");
    expect(facts.fromDayPart).toBe("вечер");
  });

  it("does not invent a night out of two daytime hours", () => {
    const noon = Date.UTC(2026, 8, 30, 8, 0) / 1000; // 12:00 at UTC+4
    const facts = gapFacts(noon, noon + 2 * 3600, 4);
    expect(facts.crossedDay).toBe(false);
    expect(facts.touchedNight).toBe(false);
    expect(facts.fromDayPart).toBe("день");
  });

  it("keeps a twenty-minute pause across midnight as a pause across midnight", () => {
    // Short and yet the day turned: the length says "continuing", the calendar
    // says "доброе утро". Both facts travel.
    const lateNight = Date.UTC(2026, 8, 30, 19, 50) / 1000; // 23:50 at UTC+4
    const facts = gapFacts(lateNight, lateNight + 20 * 60, 4);
    expect(facts.label).toBe("20 минут");
    expect(facts.crossedDay).toBe(true);
    expect(facts.touchedNight).toBe(true);
  });

  it("reads the clock in his zone, not the box's", () => {
    // 23:00 UTC is 03:00 for him — the server's midnight is not his.
    const ts = Date.UTC(2026, 8, 30, 23, 0) / 1000;
    expect(dayPart(ts, 4)).toBe("ночь");
    expect(dayPart(ts, 0)).toBe("ночь");
    const evening = Date.UTC(2026, 8, 30, 16, 30) / 1000; // 20:30 at UTC+4
    expect(dayPart(evening, 4)).toBe("вечер");
    expect(dayPart(evening, 0)).toBe("день");
  });
});

describe("previousLiveMessage", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-gap-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("returns the last sentence either of them said", () => {
    saveMessage("u1", "telegram", "user", "Да, лучше поиграю");
    saveMessage("u1", "telegram", "assistant", "Одобряю, спасай мир");
    expect(previousLiveMessage("u1")).toMatchObject({ role: "assistant" });
  });

  it("walks past tool results — they are not things anybody said", () => {
    saveMessage("u1", "telegram", "user", "проверь сервер");
    saveMessage("u1", "telegram", "assistant", "", undefined, [{ id: "c1", name: "shell", arguments: {} }]);
    saveMessage("u1", "telegram", "tool", "load 0.11", "c1");
    saveMessage("u1", "telegram", "assistant", "всё в порядке");
    expect(previousLiveMessage("u1")).toMatchObject({ role: "assistant" });
  });

  it("ignores a scheduled report, both halves of it", () => {
    // The report is a row with role "user" and an answer with role "assistant",
    // and neither is a thing they said to each other. Measured from it, his
    // reply two minutes after the report would look like a two-minute pause —
    // the real silence of twenty hours would vanish behind the bot's own talk.
    saveMessage("u1", "telegram", "user", "Да, лучше поиграю");
    const realReplyId = saveMessage("u1", "telegram", "assistant", "Одобряю, спасай мир");
    saveMessage("u1", "telegram", "user", `${SCHEDULED_TURN_PREFIX} "server_watch".`);
    saveMessage("u1", "telegram", "assistant", "Жень, сервер в порядке");

    // Her reply to the report is a real row and not a real sentence: measured
    // from it, the twenty hours since he last wrote would shrink to minutes.
    expect(previousLiveMessage("u1")!.id).toBe(realReplyId);
  });

  it("has nothing to say about the very first message", () => {
    expect(previousLiveMessage("nobody")).toBeNull();
  });
});

describe("loadSummary", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-gap-sum-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("dates a folded stretch, so the past does not become one undated 'как-то раз'", () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (id, user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(101, "u1", "telegram", "user", "про самолёты", DeviceDate(2026, 8, 23, 10));
    insert.run(150, "u1", "telegram", "assistant", "ага", DeviceDate(2026, 8, 26, 10));

    saveSummaryChunk("u1", { fromId: 101, toId: 150, summary: "говорили про самолёты", tokenEstimate: 10 });
    expect(loadSummary("u1", 4)).toBe("[23.09–26.09] говорили про самолёты");
  });

  it("leaves a carried-over summary undated rather than guessing its date", () => {
    // The carry from an older install points at rows that are already gone; a
    // date invented for it would be a worse lie than no date.
    saveSummaryChunk("u1", { fromId: 0, toId: 0, summary: "старая сводка", tokenEstimate: 5 });
    expect(loadSummary("u1", 4)).toBe("старая сводка");
  });
});

describe("the pause in the prompt", () => {
  const notice: GapNotice = {
    seconds: LIVE_TO - LIVE_FROM,
    label: "почти сутки",
    crossedDay: true,
    touchedNight: true,
    fromDate: "29.09",
    fromDayPart: "вечер",
    prevRole: "assistant",
  };

  it("tells her how long he was gone and that the scene is stale", () => {
    const prompt = buildSystemPrompt({ name: "Ева" }, undefined, undefined, undefined, notice);
    expect(prompt).toContain("## Время между сообщениями");
    expect(prompt).toContain("почти сутки");
    expect(prompt).toContain("последней писала ты");
    expect(prompt).toContain("29.09, вечер");
    expect(prompt).toContain("сменились сутки");
    expect(prompt).toContain("в паузу попала ночь");
    expect(prompt).toContain("расстояние, а не доклад");
  });

  it("says nothing at all when there was no pause", () => {
    // An ordinary turn must be untouched: a marker on every message is how she
    // turns into a stopwatch, and the silence she never had is the best place
    // to start avoiding it.
    const prompt = buildSystemPrompt({ name: "Ева" });
    expect(prompt).not.toContain("Время между сообщениями");
  });

  it("says who went quiet", () => {
    const prompt = buildSystemPrompt({ name: "Ева" }, undefined, undefined, undefined, {
      ...notice,
      prevRole: "user",
    });
    expect(prompt).toContain("последним писал он");
  });
});

describe("Engine time gap", () => {
  let dbPath: string;
  let dir: string;
  const savedConfigPath = process.env.EVA_CONFIG_PATH;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-gap-eng-${crypto.randomUUID()}.db`);
    getDB(dbPath);

    // The engine rereads her identity from the config file on every request, so
    // a test about a config value has to own that file. Without this it reads
    // whatever install the machine happens to have — which is invisible on a
    // box with no `~/.eva/config.yaml` and very visible on the server, where the
    // live config lives exactly there.
    dir = path.join(os.tmpdir(), `betsy-gap-cfg-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    process.env.EVA_CONFIG_PATH = path.join(dir, "config.yaml");
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedConfigPath === undefined) delete process.env.EVA_CONFIG_PATH;
    else process.env.EVA_CONFIG_PATH = savedConfigPath;
  });

  /** An engine whose config file carries exactly these `agent` values. */
  function engineWith(chat: ReturnType<typeof vi.fn>, agent: Record<string, unknown> = {}) {
    saveConfig(
      { agent: { name: "Ева", gender: "neutral", personality: {}, ...agent } } as never,
      process.env.EVA_CONFIG_PATH!,
    );
    return new Engine({
      llm: { fast: () => ({ chat }), strong: () => ({ chat }) },
      config: { name: "Ева" },
      tools: new ToolRegistry(),
    });
  }

  it("puts the measured pause into the request after a long silence", async () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("u1", "telegram", "user", "Да, лучше поиграю", LIVE_FROM);
    insert.run("u1", "telegram", "assistant", "Одобряю, спасай мир", LIVE_FROM);

    const chat = vi.fn().mockResolvedValue({ text: "о, привет", stopReason: "end_turn" });
    const engine = engineWith(chat);
    await engine.process({
      channelName: "telegram",
      userId: "u1",
      text: "Привет",
      timestamp: LIVE_TO * 1000,
    });

    const [request] = chat.mock.calls[0];
    const system = request[0].content as string;
    expect(system).toContain("Время между сообщениями");
    expect(system).toContain("почти сутки");
  });

  it("keeps an ordinary exchange seamless", async () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Math.floor(Date.now() / 1000);
    insert.run("u1", "telegram", "user", "а помнишь", now - 120);
    insert.run("u1", "telegram", "assistant", "конечно", now - 100);

    const chat = vi.fn().mockResolvedValue({ text: "ага", stopReason: "end_turn" });
    const engine = engineWith(chat);
    await engine.process({ channelName: "telegram", userId: "u1", text: "и вот", timestamp: now * 1000 });

    const [request] = chat.mock.calls[0];
    expect(request[0].content as string).not.toContain("Время между сообщениями");
  });

  it("honours a threshold raised in the config, with no restart", async () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Math.floor(Date.now() / 1000);
    insert.run("u1", "telegram", "user", "пошёл спать", now - 3 * 3600);
    insert.run("u1", "telegram", "assistant", "спокойной ночи", now - 3 * 3600);

    const chat = vi.fn().mockResolvedValue({ text: "доброе утро", stopReason: "end_turn" });
    const engine = engineWith(chat, { gap_threshold_min: 600 });
    await engine.process({ channelName: "telegram", userId: "u1", text: "доброе", timestamp: now * 1000 });

    const [request] = chat.mock.calls[0];
    expect(request[0].content as string).not.toContain("Время между сообщениями");
  });

  it("does not read her own scheduled report as the last thing she said", async () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Math.floor(Date.now() / 1000);
    insert.run("u1", "telegram", "user", "Да, лучше поиграю", now - 21 * 3600);
    insert.run("u1", "telegram", "assistant", "Одобряю", now - 21 * 3600);
    insert.run("u1", "telegram", "user", `${SCHEDULED_TURN_PREFIX} "server_watch".`, now - 60);
    insert.run("u1", "telegram", "assistant", "Жень, сервер в порядке", now - 59);

    const chat = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const engine = engineWith(chat);
    await engine.process({ channelName: "telegram", userId: "u1", text: "Привет", timestamp: now * 1000 });

    const [request] = chat.mock.calls[0];
    const system = request[0].content as string;
    // Measured from the report it would be "минуту" — the real silence is a day.
    expect(system).toContain("Время между сообщениями");
    expect(system).toContain("почти сутки");
  });

  it("stays quiet on a scheduled turn of her own", async () => {
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Math.floor(Date.now() / 1000);
    insert.run("u1", "telegram", "user", "Да, лучше поиграю", now - 14 * 3600);
    insert.run("u1", "telegram", "assistant", "Одобряю", now - 14 * 3600);

    const chat = vi.fn().mockResolvedValue({ text: "отчёт", stopReason: "end_turn" });
    const engine = engineWith(chat);
    await engine.process({
      channelName: "telegram",
      userId: "u1",
      text: `${SCHEDULED_TURN_PREFIX} "server_watch".`,
      timestamp: now * 1000,
      metadata: { scheduledTask: true },
    });

    const [request] = chat.mock.calls[0];
    expect(request[0].content as string).not.toContain("Время между сообщениями");
  });
});

/** Unix seconds for a UTC instant, so the fixtures do not depend on the box's zone. */
function DeviceDate(year: number, monthIndex: number, day: number, hour: number): number {
  return Date.UTC(year, monthIndex, day, hour) / 1000;
}

describe("relativeAge still speaks with the same voice", () => {
  it("words an age and a silence from one vocabulary", () => {
    // Not a duplicate of knowledge's own tests: this one exists so that moving
    // the wording out of knowledge.ts cannot silently change what memory says.
    const now = Math.floor(Date.now() / 1000);
    expect(relativeAge(now - 5 * 86400, now)).toBe("5 дней назад");
    expect(humanGap(5 * 86400)).toBe("5 дней");
  });
});
