import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { getDB, closeDB, writeMeta } from "../../src/core/memory/db.js";
import {
  checkVoiceBudget,
  noteVoiceSent,
  VOICE_GAP_MIN,
  VOICE_PER_DAY,
} from "../../src/core/voice-budget.js";

/**
 * The voice budget, in the owner's own terms: "отправив голос в 19:39, следующее
 * не раньше 20:00, независимо от кол-ва других сообщений" — and "asked for is
 * asked for", because a limit that made her refuse him would be worse than the
 * problem it solves.
 *
 * The gap is the part that matters: measured before this, 27 voices in four hours,
 * and a daily ceiling alone cannot stop that — twenty can be spent in one hour.
 */

let dbPath: string;
// Relative to the real clock: the budget answers "may she speak now", so a fixture
// in the future would read as a gap of minus two days.
let now: number;

describe("voice budget", () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-voice-${crypto.randomUUID()}.db`);
    getDB(dbPath);
    now = Math.floor(Date.now() / 1000);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("allows the first voice of the day", () => {
    const budget = checkVoiceBudget(false);
    expect(budget.allow).toBe(true);
    expect(budget.remaining).toBe(VOICE_PER_DAY);
  });

  it("refuses the next one until the gap has passed, counted from the last voice", () => {
    writeMeta("voice_sent_at", JSON.stringify([now - 5 * 60]));

    const budget = checkVoiceBudget(false);
    expect(budget.allow).toBe(false);
    expect(budget.waitMin).toBe(VOICE_GAP_MIN - 5);
    // And the text says what to do instead, because a refusal she cannot act on
    // is a turn that stops.
    expect(budget.reason).toContain("Ответь текстом");
  });

  it("does not count other messages in between", () => {
    // "независимо от кол-ва других сообщений, текст или картинка": the clock runs
    // from the last voice, so a long text conversation in between changes nothing.
    writeMeta("voice_sent_at", JSON.stringify([now - VOICE_GAP_MIN * 60]));
    expect(checkVoiceBudget(false).allow).toBe(true);
  });

  it("refuses past the day's ceiling, and says what is left", () => {
    const day = Array.from({ length: VOICE_PER_DAY }, (_, i) => now - (i + 1) * 3600);
    writeMeta("voice_sent_at", JSON.stringify(day));

    const budget = checkVoiceBudget(false);
    expect(budget.allow).toBe(false);
    expect(budget.remaining).toBe(0);
    expect(budget.reason).toContain("Женя попросит");
  });

  it("lets his request through both rules", () => {
    // His voice note, or "скажи голосом": the owner's ask outranks her budget,
    // and this is checked before anything else so no state can make her refuse him.
    const day = Array.from({ length: VOICE_PER_DAY }, (_, i) => now - i * 60);
    writeMeta("voice_sent_at", JSON.stringify(day));

    const asked = checkVoiceBudget(true);
    expect(asked.allow).toBe(true);
    expect(asked.waitMin).toBe(0);
  });

  it("forgets voices older than a day", () => {
    writeMeta("voice_sent_at", JSON.stringify([now - 25 * 3600, now - 26 * 3600]));
    const budget = checkVoiceBudget(false);
    expect(budget.allow).toBe(true);
    expect(budget.remaining).toBe(VOICE_PER_DAY);
  });

  it("records what actually went out", () => {
    noteVoiceSent(now);
    expect(checkVoiceBudget(false).remaining).toBe(VOICE_PER_DAY - 1);
  });
});
