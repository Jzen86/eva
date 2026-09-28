import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDB, closeDB, writeMeta } from "../../src/core/memory/db.js";
import { shouldStudy } from "../../src/core/memory/learning.js";

/**
 * What a restart must not do to the cooldown.
 *
 * Its own file, and that is the point rather than tidiness. The thing under test
 * is the state of a process that has run nothing yet, and the in-memory cache is
 * exactly what no test in a shared file can promise — `markStudyComplete` in any
 * earlier test would have set it, and then this passes or fails by ordering. A
 * fresh module registry per file gives the only honest starting point: nothing
 * has ever run here.
 *
 * The bug it guards: the cooldown lived only in a variable and every boot reset
 * it, so a bot restarted more often than its interval never studied. The live
 * install is the proof — four restarts inside ten minutes, two deploys and two
 * others, and the knowledge base gained nothing for two hours while looking
 * healthy.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-restart-"));
  closeDB();
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

const learning = (minutes: number) => ({
  learningEnabled: true,
  studyIntervalMs: minutes * 60_000,
  specialties: [],
});

describe("the study cooldown across a restart", () => {
  it("is read from the record, not from the process", () => {
    // A run a minute ago, recorded by a process that no longer exists. Nothing
    // has run here, so only the record can answer.
    writeMeta("study_last_run", String(Math.floor(Date.now() / 1000) - 60));

    // Too soon for a five-minute interval, and restarting again changes nothing.
    expect(shouldStudy(learning(5))).toBe(false);
    // Due for a one-minute interval: a restart must not push the deadline back.
    expect(shouldStudy(learning(1))).toBe(true);
  });

  it("studies at once when the record is old enough", () => {
    writeMeta("study_last_run", String(Math.floor(Date.now() / 1000) - 3600));

    expect(shouldStudy(learning(10))).toBe(true);
  });
});
