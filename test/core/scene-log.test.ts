import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  recordScene,
  recentScenes,
  renderRecentFrames,
  SCENE_KEEP,
  SCENE_LINE_LIMIT,
} from "../../src/core/memory/scene-log.js";

/**
 * The log of frames she has already made.
 *
 * What it is for: the next scene must not be the last one. Measured on the live
 * install — 165 frames in two weeks, the same room, the same morning, the same
 * smirk — and the probe that fixed it: shown its own last frames, the writer
 * spread across locations, poses, hairstyles and moods. So the storage has to be
 * exact (what she wrote, newest first) and the block has to stay small (it is in
 * front of her on every turn).
 */

let dbPath: string;

describe("scene log", () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-scenes-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("gives back what she drew, newest first", () => {
    recordScene("u1", "спальня, пучок, ухмылка", "direct");
    recordScene("u1", "кухня, распущенные волосы, улыбка", "mirror");

    const rows = recentScenes("u1");
    expect(rows).toHaveLength(2);
    // Newest first: the prompt lists them in this order, and the rule reads
    // "последние сверху".
    expect(rows[0].context).toContain("кухня");
    expect(rows[1].context).toContain("спальня");
    expect(rows[0].mode).toBe("mirror");
  });

  it("does not remember the same scene twice when the tool draws it twice", () => {
    // A second identical attempt is let through on purpose (a check she cannot
    // satisfy must not trap her), so the same words can arrive twice in a turn.
    // Stored twice, they would read as two memories instead of one frame — and
    // the block would spend a line saying "not this" about a single picture.
    recordScene("u2", "ванная, полотенце на волосах");
    recordScene("u2", "ванная, полотенце на волосах");

    expect(recentScenes("u2")).toHaveLength(1);
  });

  it("keeps the list bounded, and does not trim another user's frames", () => {
    const total = SCENE_KEEP + 5;
    for (let i = 0; i < total; i++) recordScene("busy", `сцена ${i}`);
    recordScene("quiet", "единственная сцена");

    expect(recentScenes("busy", total)).toHaveLength(SCENE_KEEP);
    // The oldest went away, the newest stayed.
    expect(recentScenes("busy", total)[0].context).toBe(`сцена ${total - 1}`);
    expect(recentScenes("quiet")).toHaveLength(1);
  });

  it("shows one frame per line, and caps a scene that runs long", () => {
    const long = `${"очень длинное описание сцены ".repeat(40)}конец`;
    const text = renderRecentFrames([
      { context: "спальня,\n  пучок,\tухмылка", mode: "direct", at: 0 },
      { context: long, mode: "direct", at: 0 },
    ]);

    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    // Whitespace inside one scene becomes one line — a raw newline would break
    // the list into something that reads as two frames.
    expect(lines[0]).toBe("- спальня, пучок, ухмылка");
    expect(lines[1].length).toBeLessThanOrEqual(SCENE_LINE_LIMIT + 3);
    // Cut at a word boundary: what was kept is a prefix of the scene, and the
    // character it stopped before is the space it stopped at.
    expect(lines[1].endsWith("…")).toBe(true);
    const kept = lines[1].slice(2, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("says nothing when there is nothing to say", () => {
    expect(renderRecentFrames([])).toBe("");
    expect(renderRecentFrames(recentScenes("nobody"))).toBe("");
  });
});
