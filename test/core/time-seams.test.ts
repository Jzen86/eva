import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { recentSeams, saveSummaryChunk, loadSummary, SCHEDULED_TURN_PREFIX } from "../../src/core/memory/conversations.js";
import { buildTimeSeams } from "../../src/core/prompt.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

const OFFSET = 4;
/** A moment on 01.10.2026, given in *his* zone and stored as UTC. */
const at = (h: number, m = 0): number => Date.UTC(2026, 9, 1, h - OFFSET, m) / 1000;

function insert(userId: string, role: string, content: string, timestamp: number): void {
  getDB()
    .prepare("INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(userId, "telegram", role, content, timestamp);
}

describe("recentSeams", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-seams-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* not there */ }
    }
  });

  it("names the pauses inside the window, not only the one before this message", () => {
    // The live case: "Поиграл" at 02:36, then code at 04:38, then chat at 05:27.
    // She merged all three into one continuous now — "пока ты там воевал со
    // своими багами" about a game she spoke of three hours earlier.
    insert("u1", "user", "Поиграл", at(2, 36));
    insert("u1", "assistant", "Ну наконец-то", at(2, 37));
    insert("u1", "user", "Голосом скажи", at(4, 38));
    insert("u1", "assistant", "Держи", at(4, 39));
    insert("u1", "user", "Теперь текстом", at(5, 27));

    const seams = recentSeams("u1");
    expect(seams.map((s) => s.head)).toEqual(["Ну наконец-то", "Держи"]);
    // 02:37 → 04:38 is two hours and one minute of silence.
    expect(seams[0].gapSeconds).toBe((2 * 60 + 1) * 60);
    expect(seams[1].gapSeconds).toBe(48 * 60);
  });

  it("walks past tool rows and the scheduler's own reports", () => {
    // A voice note leaves a `tool` row nobody said, and a report leaves a `user`
    // row that is not him talking. Counting either as a sentence would invent a
    // seam where nothing was said.
    insert("u2", "user", "привет", at(1, 0));
    insert("u2", "tool", "Голосовое готово и отправлено.", at(1, 1));
    insert("u2", "user", `${SCHEDULED_TURN_PREFIX} "server_watch".`, at(3, 0));
    insert("u2", "assistant", "Сервер в порядке", at(3, 1));
    insert("u2", "user", "Привет", at(4, 0));

    const seams = recentSeams("u2");
    expect(seams).toHaveLength(1);
    expect(seams[0].head).toBe("привет");
    expect(seams[0].gapSeconds).toBe(3 * 3600);
  });
});

describe("buildTimeSeams", () => {
  it("says when the old thing was and how long the silence after it was", () => {
    const rendered = buildTimeSeams(
      [{ id: 1, role: "user", timestamp: at(2, 36), head: "Поиграл", gapSeconds: 2 * 3600 + 120 }],
      OFFSET,
    );
    expect(rendered).toContain("## Швы во времени");
    expect(rendered).toContain("02:36");
    expect(rendered).toContain("Поиграл");
    expect(rendered).toContain("около двух часов");
  });

  it("says nothing at all when the window has no pauses", () => {
    expect(buildTimeSeams([], OFFSET)).toBe("");
  });
});

describe("loadSummary", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-summary-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* not there */ }
    }
  });

  it("dates a fold with a clock and says how long ago it ended", () => {
    // The live case: the newest fold on the install ran 02:04-02:46 and printed
    // as "[01.10]" — the same date as the code session twenty minutes old. So the
    // game talk read as current, and she answered it as such.
    const endedAt = Math.floor(Date.now() / 1000) - 3 * 3600;
    insert("u3", "user", "Поиграл", endedAt - 60);
    insert("u3", "assistant", "Ну наконец-то", endedAt);
    const rows = getDB().prepare("SELECT id FROM conversations ORDER BY id").all() as Array<{ id: number }>;
    saveSummaryChunk("u3", { fromId: rows[0].id, toId: rows[1].id, summary: "Он вернулся из игры.", tokenEstimate: 40 });

    const summary = loadSummary("u3", OFFSET);
    // The range carries a clock now, not only a date.
    expect(summary).toMatch(/\[\d{2}\.\d{2} \d{2}:\d{2}/);
    expect(summary).toContain("Он вернулся из игры.");
    expect(summary).toContain("назад");
    expect(summary).toContain("Это прошлое");
  });
});
