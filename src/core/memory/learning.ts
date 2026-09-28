import { getAllKnowledge, addKnowledge } from "./knowledge.js";
import type { KnowledgeRow } from "./knowledge.js";
import { readMeta, writeMeta } from "./db.js";

export interface LearningConfig {
  learningEnabled: boolean;
  studyIntervalMs: number;
  specialties: string[];
}

/** Where the last run is remembered, in unix seconds. */
const META_KEY = "study_last_run";

let lastStudyTimestamp = 0;

/**
 * When the last session ran, from either the record or this process.
 *
 * The record is the one that matters. This used to be a variable and nothing
 * else, and `primeStudyTimer` reset it on every boot — which reads as "a restart
 * should not instantly fire a session" and behaves as "a bot that restarts more
 * often than the interval never studies at all". That is not hypothetical: the
 * live install took its deploys and a couple of restarts inside ten minutes and
 * the knowledge base gained nothing for two hours while looking healthy.
 *
 * The in-process value is kept as a cache, so a run that cannot write its time
 * still holds the cooldown for this process rather than firing on every tick.
 */
function lastRunMs(): number {
  let stored = 0;
  try {
    stored = Number(readMeta(META_KEY) ?? "0") * 1000;
  } catch {
    // No database yet: this process is all we know about.
  }
  return Math.max(stored, lastStudyTimestamp);
}

/**
 * Determine whether it is time to run a study session.
 * Returns true if learning is enabled and enough time has elapsed.
 */
export function shouldStudy(config: LearningConfig): boolean {
  if (!config.learningEnabled) return false;
  return Date.now() - lastRunMs() >= config.studyIntervalMs;
}

/**
 * Mark a study session as completed (resets the timer).
 */
export function markStudyComplete(): void {
  lastStudyTimestamp = Date.now();
  try {
    writeMeta(META_KEY, String(Math.floor(lastStudyTimestamp / 1000)));
  } catch {
    // An unrecordable run still ran; the in-memory value keeps this process
    // honest and the next boot starts from whatever was last written.
  }
}

export interface StudyResult {
  topic: string;
  insight: string;
  /** False when the writer refused the insight as a repeat. */
  written: boolean;
  reason: string;
  entriesBefore: number;
  entriesAfter: number;
}

/**
 * `runStudySession` used to live here — a single-insight runner the study prompt
 * plugged into, and the reason this file existed. It is gone: the prompt now
 * returns several facts or cases rather than one conclusion, and a wrapper shaped
 * around one entry would have had to grow a list, a per-entry dedupe and a
 * per-entry report to hold what study-runner already does directly.
 */
