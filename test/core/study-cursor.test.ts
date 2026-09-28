import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, studyCursor, setStudyCursor } from "../../src/core/memory/conversations.js";
import { addKnowledge, relativeAge } from "../../src/core/memory/knowledge.js";
import { runStudy } from "../../src/core/memory/study-runner.js";
import { shouldStudy, markStudyComplete } from "../../src/core/memory/learning.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * What a study session reads.
 *
 * It used to read the newest twenty messages, which makes what gets studied a
 * function of how busy the chat was. A correction landing in a quiet hour is read
 * and one landing in a loud hour is skipped, and neither has anything to do with
 * whether the moment mattered. The cursor makes it a function of what has been
 * read, which is the only question worth asking.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-cursor-"));
  closeDB();
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One message per entry; `role` alternates so both sides of the talk are read. */
function say(texts: string[]): void {
  texts.forEach((text, i) => {
    saveMessage("u1", "telegram", i % 2 === 0 ? "assistant" : "user", text);
  });
}

/** Run one session against a canned answer and hand back the prompt it saw. */
async function session(answer = '{"facts": []}'): Promise<{ prompt: string; wrote: boolean }> {
  let prompt = "";
  const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
    prompt = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    return { text: answer, stopReason: "end_turn" };
  });
  const result = await runStudy({
    clients: [{ chat } as never],
    agentName: "Ева",
    userId: "u1",
    learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
    maxKnowledge: 50,
  });
  return { prompt, wrote: result.wrote };
}

describe("study: the read cursor", () => {
  it("reads a moment that is far behind the newest messages", async () => {
    // The bug, exactly. A mistake and the correction it earned, then forty
    // messages of ordinary talk. The last twenty messages are all filler, so the
    // old window could not have seen either half of the pair — not "unlikely to",
    // could not — and the correction was the thing worth learning from.
    say(["я нагрубила ему ни за что", "опять ты это сделала, я же просил"]);
    say(Array.from({ length: 40 }, (_, i) => `болтовня ${i}`));

    const { prompt } = await session();

    expect(prompt).toContain("я нагрубила ему ни за что");
    expect(prompt).toContain("опять ты это сделала, я же просил");
  });

  it("moves the cursor and does not read the same messages twice", async () => {
    say(["первое сообщение", "второе сообщение"]);

    const first = await session();
    expect(first.prompt).toContain("первое сообщение");
    expect(studyCursor("u1")).toBeGreaterThan(0);

    const second = await session();
    expect(second.prompt).not.toContain("первое сообщение");
    expect(second.prompt).not.toContain("второе сообщение");
  });

  it("picks up where it left off when new messages arrive", async () => {
    say(["старое сообщение"]);
    await session();

    say(["новое сообщение"]);
    const { prompt } = await session();

    expect(prompt).toContain("новое сообщение");
    expect(prompt).not.toContain("старое сообщение");
  });

  it("leaves the cursor alone when the model never answered", async () => {
    // An error is not a read. Moving the cursor here would skip the batch for good
    // — the session failed, not the messages.
    say(["важное сообщение"]);
    const chat = vi.fn().mockRejectedValue(new Error("сеть легла"));

    const failed = await runStudy({
      clients: [{ chat } as never],
      agentName: "Ева",
      userId: "u1",
      learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
      maxKnowledge: 50,
    });

    expect(failed.error).toBeTruthy();
    expect(studyCursor("u1")).toBe(0);

    const { prompt } = await session();
    expect(prompt).toContain("важное сообщение");
  });

  it("advances even when nothing was worth keeping", async () => {
    // "Nothing happened" is an answer. Re-asking the same batch every hour
    // because it produced nothing is how a session turns into a loop.
    say(["пустой разговор"]);
    await session('{"facts": [], "reason": "ничего не произошло"}');

    expect(studyCursor("u1")).toBeGreaterThan(0);
  });

  it("never moves backwards", async () => {
    say(["одно", "два", "три"]);
    await session();
    const at = studyCursor("u1");

    setStudyCursor("u1", 1);

    expect(studyCursor("u1")).toBe(at);
  });

  it("starts near the end of a history it has never read", async () => {
    // The live install: weeks of talk, no cursor. Started at zero, the first
    // session would read the oldest messages there are, which are already in the
    // base, and would take days of hourly runs to reach anything current.
    say(Array.from({ length: 300 }, (_, i) => `МЕТКА-${String(i).padStart(3, "0")}`));

    const { prompt } = await session();

    expect(prompt).toContain("МЕТКА-299");
    expect(prompt).not.toContain("МЕТКА-000");
  });

  it("does not re-seed once a session has landed", async () => {
    say(Array.from({ length: 300 }, (_, i) => `МЕТКА-${String(i).padStart(3, "0")}`));
    await session();
    const seeded = studyCursor("u1");
    expect(seeded).toBeGreaterThan(200);

    say(["после курсора"]);
    const { prompt } = await session();

    expect(prompt).toContain("после курсора");
    expect(prompt).not.toContain("МЕТКА-299");
    expect(studyCursor("u1")).toBeGreaterThan(seeded);
  });

  it("defers what the budget cannot fit instead of losing it", async () => {
    // The property that makes the cursor safe, and the reason the overflow is
    // kept oldest-first. The cursor is a high-water mark, so everything up to it
    // counts as read: a batch cut from the front would leave the dropped messages
    // below the mark and the pointer claiming they had been read. Cut from the
    // back and the pointer stays true and the remainder waits its turn.
    const marks = Array.from(
      { length: 25 },
      (_, i) => `МЕТКА-${String(i).padStart(2, "0")}` + "я".repeat(900),
    );
    say(marks);

    const first = await session();
    const firstCursor = studyCursor("u1");

    // The oldest went in, the newest was held back, and the pointer stopped at
    // the last one that actually went in.
    expect(first.prompt).toContain("МЕТКА-00");
    expect(first.prompt).not.toContain("МЕТКА-24");
    expect(firstCursor).toBeLessThan(marks.length);

    // Nothing was lost: the next session picks up exactly where it stopped.
    const second = await session();
    expect(second.prompt).toContain("МЕТКА-24");
    expect(second.prompt).not.toContain("МЕТКА-00");
  });

  it("says so in the report when a batch did not fit", async () => {
    // A chat producing more than one budget an hour has to look like a backlog,
    // not like nothing happening.
    say(Array.from({ length: 25 }, (_, i) => `МЕТКА-${String(i).padStart(2, "0")}` + "я".repeat(900)));

    const chat = vi.fn().mockResolvedValue({ text: '{"facts": []}', stopReason: "end_turn" });
    const result = await runStudy({
      clients: [{ chat } as never],
      agentName: "Ева",
      userId: "u1",
      learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
      maxKnowledge: 50,
    });

    expect(result.report).toContain("в следующую сессию");
  });

  it("dates a row by the conversation, not by the run", async () => {
    // A session reading a backfill is reconstructing days-old talk. Stamped at
    // the run, every row recovered from an old conversation would be dated today,
    // and "мы говорили об этом неделю назад" would be a falsehood the base tells
    // about itself — precisely during the backfill, which is when it happens.
    say(["обсуждали самолёты, он летал в Саратов"]);
    const fiveDaysAgo = Math.floor(Date.now() / 1000) - 5 * 86_400;
    getDB().prepare("UPDATE conversations SET timestamp = ?").run(fiveDaysAgo);

    await session(
      JSON.stringify({ facts: [{ topic: "самолёты", fact: "летал в Саратов" }] }),
    );

    const row = getDB().prepare("SELECT timestamp FROM knowledge").get() as {
      timestamp: number;
    };
    expect(row.timestamp).toBe(fiveDaysAgo);
    expect(relativeAge(row.timestamp)).toBe("5 дней назад");
  });

  it("resets the cooldown even when every fact turned out to be a duplicate", async () => {
    // Found while writing the cursor. The duplicate path returned without
    // reaching `markStudyComplete`, so the timer still read as expired and the
    // study model re-fired on the next tick and every tick after it, once per
    // minute, for as long as the model kept repeating itself.
    addKnowledge({ topic: "техника", insight: "Женя не любит айфоны", source: "memory_tool" });
    say(["разговор"]);

    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      markStudyComplete();
      now.mockReturnValue(3600_000);
      const learning = { learningEnabled: true, studyIntervalMs: 60_000, specialties: [] };
      expect(shouldStudy(learning)).toBe(true);

      const { wrote } = await session(
        JSON.stringify({
          facts: [{ topic: "техника", fact: "Женя не любит айфоны" }],
        }),
      );

      expect(wrote).toBe(false);
      expect(shouldStudy(learning)).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});
