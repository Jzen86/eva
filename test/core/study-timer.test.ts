import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDB, closeDB, readMeta } from "../../src/core/memory/db.js";
import { shouldStudy, markStudyComplete } from "../../src/core/memory/learning.js";

/**
 * The study cooldown, and the one way it silently stopped working.
 *
 * It lived only in a variable and every boot reset it, which reads as "a restart
 * should not instantly fire a session" and behaves as "a bot that restarts more
 * often than the interval never studies at all". The live install is the proof:
 * four restarts inside ten minutes — two deploys and two others — and the
 * knowledge base gained nothing for two hours while looking perfectly healthy.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-timer-"));
  closeDB();
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the study cooldown", () => {
  it("is recorded outside the process, so a restart inherits it", () => {
    markStudyComplete();

    const stored = Number(readMeta("study_last_run") ?? "0");
    expect(stored).toBeGreaterThan(0);
    expect(Math.abs(stored - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it("still refuses to study when learning is off", () => {
    expect(shouldStudy({ learningEnabled: false, studyIntervalMs: 0, specialties: [] })).toBe(false);
  });
});
