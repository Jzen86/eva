/**
 * Deciding whether a new memory says something the base already says.
 *
 * This lives outside study-runner on purpose: the study prompt is off limits,
 * but the comparison it calls is ordinary logic and deserves its own tests.
 */
import { stemsOfFiltered } from "./stem-ru.js";
import type { KnowledgeRow } from "./knowledge.js";
import { cosineSimilarity, generateEmbedding, bufferToEmbedding } from "../../services/embeddings.js";

import { getDB } from "./db.js";
import { addKnowledge, getAllKnowledge } from "./knowledge.js";
import { embeddingToBuffer } from "../../services/embeddings.js";

/** Below this, a lexical match is noise rather than a repeat. */
export const LEXICAL_DUPLICATE_THRESHOLD = 0.6;

/** Cosine at or above which two vectors are treated as the same claim. */
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.93;

const NOISE = new Set([
  "это", "как", "что", "для", "или", "не", "но", "же", "бы", "ли", "вот",
  "все", "всё", "уже", "ещё", "еще", "там", "тут", "мне", "меня", "тебе",
  "его", "её", "их", "нас", "вас", "ты", "вы", "мы", "он", "она", "они",
  "оно", "про", "из", "по", "за", "о", "об", "у", "а", "и", "в", "с", "к",
  "на", "до", "над", "под", "the", "and", "for", "you", "are", "was", "is",
]);

/** Content stems of a piece of text: lowercased, ё folded to е, noise dropped. */
export function contentStems(text: string): Set<string> {
  return new Set(stemsOfFiltered(text, NOISE));
}

/**
 * How much of `candidate` is already covered by `existing`, from 0 to 1.
 *
 * The denominator is the candidate's own size, deliberately. Dividing by the
 * smaller of the two sets — the obvious symmetric-looking choice — means a
 * long, informative new insight that happens to mention one known word scores
 * 1.0 against a one-word entry and gets thrown away as a repeat. That is data
 * loss, and it was the actual behaviour: "Женя любит пиццу каждый день" was
 * rejected as a duplicate of an existing "пицца".
 */
export function coverageOf(candidate: Set<string>, existing: Set<string>): number {
  if (candidate.size === 0 || existing.size === 0) return 0;
  let shared = 0;
  for (const stem of candidate) {
    if (existing.has(stem)) shared++;
  }
  return shared / candidate.size;
}

export interface DuplicateHit {
  id: number;
  /** How the match was made, for logging. */
  how: "exact" | "lexical" | "semantic";
  score: number;
  insight: string;
}

/**
 * Does this insight repeat something already stored?
 *
 * Lexical first: it is free, it needs no endpoint, and on a base this small it
 * catches most repeats. Semantic second, and only when an embedding endpoint is
 * configured — an install without one behaves exactly as it did before.
 */
export function findLexicalDuplicate(
  insight: string,
  known: KnowledgeRow[],
  threshold = LEXICAL_DUPLICATE_THRESHOLD,
): DuplicateHit | null {
  const candidate = contentStems(insight);
  if (candidate.size === 0) return null;
  const normalized = insight.trim().toLowerCase().replace(/\s+/g, " ");

  for (const row of known) {
    if (row.superseded_at !== null && row.superseded_at !== undefined) continue;
    const existing = row.insight ?? "";
    if (existing.trim().toLowerCase().replace(/\s+/g, " ") === normalized) {
      return { id: row.id, how: "exact", score: 1, insight: existing };
    }
    const score = coverageOf(candidate, contentStems(existing));
    if (score >= threshold) {
      return { id: row.id, how: "lexical", score, insight: existing };
    }
  }
  return null;
}

export interface EmbeddingEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Stored vectors for the live entries, keyed by row id.
 *
 * Rows without a vector are simply absent: they predate the endpoint being
 * configured, and re-embedding the whole base on every comparison would cost an
 * API call per row per candidate. They stay reachable through the lexical path.
 */
export function loadStoredEmbeddings(includeSuperseded = false): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  const where = includeSuperseded ? "" : " WHERE superseded_at IS NULL AND embedding IS NOT NULL";
  try {
    const rows = getDB()
      .prepare(`SELECT id, embedding FROM knowledge${where}`)
      .all() as Array<{ id: number; embedding: Buffer | null }>;
    for (const row of rows) {
      if (!row.embedding) continue;
      out.set(row.id, bufferToEmbedding(row.embedding));
    }
  } catch {
    // A base with no such column yet: lexical dedup still applies.
  }
  return out;
}

/**
 * Compare against stored vectors. Returns the closest row over the threshold,
 * or null. A failed API call is not an error here — dedup is an optimisation,
 * and losing it is better than losing the memory.
 */
export async function findSemanticDuplicate(
  text: string,
  endpoint: EmbeddingEndpoint,
  threshold = SEMANTIC_DUPLICATE_THRESHOLD,
): Promise<DuplicateHit | null> {
  let query: Float32Array;
  try {
    query = await generateEmbedding(text, endpoint);
  } catch {
    return null;
  }

  let best: DuplicateHit | null = null;
  for (const [id, vector] of loadStoredEmbeddings()) {
    if (vector.length !== query.length) continue;
    const score = cosineSimilarity(query, vector);
    if (score >= threshold && (!best || score > best.score)) {
      best = { id, how: "semantic", score, insight: "" };
    }
  }

  if (best) {
    try {
      const row = getDB().prepare("SELECT insight FROM knowledge WHERE id = ?").get(best.id) as
        | { insight: string }
        | undefined;
      if (row) best.insight = row.insight;
    } catch {
      /* the id is enough to act on */
    }
  }
  return best;
}

export interface DedupeOptions {
  known: KnowledgeRow[];
  /** Omit to run the lexical comparison only. */
  embedding?: EmbeddingEndpoint | null;
  lexicalThreshold?: number;
  semanticThreshold?: number;
}

/** Lexical and, when an endpoint is available, semantic. */
export async function findDuplicate(
  insight: string,
  opts: DedupeOptions,
): Promise<DuplicateHit | null> {
  const lexical = findLexicalDuplicate(insight, opts.known, opts.lexicalThreshold);
  if (lexical) return lexical;
  if (!opts.embedding) return null;
  return findSemanticDuplicate(insight, opts.embedding, opts.semanticThreshold);
}

export interface LearnInput {
  topic: string;
  insight: string;
  source: string;
  zone?: string;
}

export type LearnOutcome =
  | { written: true; id: number; reason: string }
  | { written: false; reason: string; duplicate: DuplicateHit | null };

/**
 * The one path a new memory should take: check it against what is already
 * stored, then write it with a vector if embeddings are available.
 *
 * Every writer goes through here rather than calling addKnowledge directly, so
 * the stored vector and the dedup decision cannot drift apart. When no endpoint
 * is configured this is exactly addKnowledge plus the lexical check.
 */
export async function learnInsight(
  input: LearnInput,
  opts: {
    known?: KnowledgeRow[];
    embedding?: EmbeddingEndpoint | null;
    confidence?: number;
  } = {},
): Promise<LearnOutcome> {
  const known = opts.known ?? getAllKnowledge();
  const duplicate = await findDuplicate(input.insight, {
    known,
    embedding: opts.embedding ?? null,
  });
  if (duplicate) {
    return { written: false, reason: "уже есть в базе", duplicate };
  }

  let vector: Buffer | null = null;
  if (opts.embedding) {
    try {
      const vec = await generateEmbedding(
        `${input.topic}. ${input.insight}`,
        opts.embedding,
      );
      vector = embeddingToBuffer(vec);
    } catch {
      // Dedup and vectors are an improvement, not a precondition. Writing the
      // memory without one is strictly better than dropping it.
      vector = null;
    }
  }

  const id = addKnowledge({ ...input, embedding: vector }, opts.confidence ?? 0.6);
  return { written: true, id, reason: "записано" };
}
