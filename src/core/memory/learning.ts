import { getAllKnowledge, addKnowledge } from "./knowledge.js";
import type { KnowledgeRow } from "./knowledge.js";

export interface LearningConfig {
  learningEnabled: boolean;
  studyIntervalMs: number;
  specialties: string[];
}

let lastStudyTimestamp = 0;

/**
 * Determine whether it is time to run a study session.
 * Returns true if learning is enabled and enough time has elapsed.
 */
export function shouldStudy(config: LearningConfig): boolean {
  if (!config.learningEnabled) return false;
  const now = Date.now();
  return now - lastStudyTimestamp >= config.studyIntervalMs;
}

/**
 * Mark a study session as completed (resets the timer).
 */
export function markStudyComplete(): void {
  lastStudyTimestamp = Date.now();
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
