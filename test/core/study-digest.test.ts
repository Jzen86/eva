import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, saveSummaryChunk } from "../../src/core/memory/conversations.js";
import { runStudy } from "../../src/core/memory/study-runner.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * The digest a study session reads is now a list of summarised stretches that
 * grows, so what it keeps when it has to cut matters: a run that keeps the head
 * reads the part already distilled into `knowledge` a dozen times and misses the
 * part that just happened, which is the only part it has not read yet.
 */
describe("study: what of the digest survives the cut", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-study-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("keeps the newest stretch when the digest does not fit", async () => {
    const oldest = "СТАРОЕ-САМОЕ-НАЧАЛО";
    const newest = "СВЕЖЕЕ-САМЫЙ-КОНЕЦ";
    // 5k each, so the 4k the study prompt allows only fits one of them.
    saveSummaryChunk("u1", { fromId: 1, toId: 10, summary: oldest + " ".repeat(5000), tokenEstimate: 1 });
    saveSummaryChunk("u1", { fromId: 11, toId: 20, summary: " ".repeat(5000) + newest, tokenEstimate: 1 });
    saveMessage("u1", "telegram", "user", "как дела");

    let prompt = "";
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      prompt = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      // No insight: the run stops right after the prompt is built, which is the
      // only part this test is about.
      return { text: "{}", stopReason: "end_turn" };
    });

    await runStudy({
      clients: [{ chat } as never],
      agentName: "Ева",
      userId: "u1",
      learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
      maxKnowledge: 50,
    });

    expect(prompt).toContain(newest);
    expect(prompt).not.toContain(oldest);
  });
});
