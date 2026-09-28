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
 * A row up for the duplicate check, in whatever detail the caller has.
 *
 * A bare string is a fact and is compared by what it says. The three case fields,
 * when present, change what the row is measured against — see identityOf.
 */
export interface DedupSubject {
  insight: string;
  her_move?: string | null;
  context?: string | null;
  his_reaction?: string | null;
  conclusion?: string | null;
}

/**
 * What makes this row the row it is.
 *
 * A fact is identified by its text, loosely: "Женя не любит айфоны" said five
 * ways is one fact, and the base should hold one of them.
 *
 * A case is identified by its whole moment, and exactly. Two cases with the same
 * trigger and opposite reactions share almost every word — "был занят → холодно"
 * and "был весёлый → тепло" — and they are the two halves of the thing cases
 * exist for. Measured by the fact rule the second scores about 0.75 against the
 * first and is refused as a repeat, so the base ends up holding one answer per
 * trigger. That is a rule, arrived at by the back door, out of the exact shape
 * this whole layer was rebuilt to stop storing.
 */
export function identityOf(
  row: DedupSubject | string,
): { text: string; exactOnly: boolean } {
  if (typeof row === "string") return { text: row, exactOnly: false };
  const conclusion = row.conclusion?.trim() ?? "";
  if (row.her_move?.trim()) {
    return {
      text: [row.her_move, row.context ?? "", row.his_reaction ?? "", conclusion]
        .map((part) => part.trim())
        .join(" | "),
      exactOnly: true,
    };
  }
  // A conclusion marks an occasion. It answers "чем кончилось", and only something
  // that happened has an ending: "Gemini лучше DeepSeek" settled on Tuesday and
  // "DeepSeek лучше Gemini" settled on Friday are two results of two arguments,
  // and the loose rule would see two nearly identical sentences and keep one —
  // leaving the base holding whichever happened to be written first, as a verdict.
  if (conclusion) return { text: `${row.insight} | ${conclusion}`, exactOnly: true };
  return { text: row.insight, exactOnly: false };
}

const squash = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Does this row repeat something already stored?
 *
 * A fact is compared loosely, by how much of it the stored text already covers,
 * because restating a known fact is how a base fills with noise.
 *
 * A case is compared to other cases by exact identity of its three parts and to
 * nothing else. Similar is not the same here — similar is the informative part.
 * A case is not held against a fact either, and a fact not against a case: a
 * statement about someone and a recorded moment are different kinds of thing, and
 * one does not make the other a repeat.
 *
 * Lexical first: it is free, it needs no endpoint, and on a base this small it
 * catches most repeats. Semantic second, and only for facts and only when an
 * embedding endpoint is configured — an install without one behaves exactly as it
 * did before.
 */
export function findLexicalDuplicate(
  subject: DedupSubject | string,
  known: KnowledgeRow[],
  threshold = LEXICAL_DUPLICATE_THRESHOLD,
): DuplicateHit | null {
  const mine = identityOf(subject);
  if (mine.text.trim().length === 0) return null;

  const stems: Set<string> | null = mine.exactOnly ? null : contentStems(mine.text);
  if (stems && stems.size === 0) return null;
  const normalized = squash(mine.text);

  for (const row of known) {
    if (row.superseded_at !== null && row.superseded_at !== undefined) continue;

    const theirs = identityOf({
      insight: row.insight ?? "",
      her_move: row.her_move,
      context: row.context,
      his_reaction: row.his_reaction,
    });

    if (mine.exactOnly || theirs.exactOnly) {
      // Cases answer only to cases, and only when it is the same moment.
      if (mine.exactOnly && theirs.exactOnly && squash(theirs.text) === normalized) {
        return { id: row.id, how: "exact", score: 1, insight: row.insight ?? "" };
      }
      continue;
    }

    if (squash(theirs.text) === normalized) {
      return { id: row.id, how: "exact", score: 1, insight: theirs.text };
    }
    const score = coverageOf(stems!, contentStems(theirs.text));
    if (score >= threshold) {
      return { id: row.id, how: "lexical", score, insight: theirs.text };
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
  subject: DedupSubject | string,
  opts: DedupeOptions,
): Promise<DuplicateHit | null> {
  const lexical = findLexicalDuplicate(subject, opts.known, opts.lexicalThreshold);
  if (lexical) return lexical;
  // Cases stop here. Their identity is exact by construction, and an embedding
  // would only add a second way to collapse the variations they exist to keep.
  if (identityOf(subject).exactOnly) return null;
  if (!opts.embedding) return null;
  const text = typeof subject === "string" ? subject : subject.insight;
  return findSemanticDuplicate(text, opts.embedding, opts.semanticThreshold);
}

export interface LearnInput extends DedupSubject {
  topic: string;
  source: string;
  /** When it happened, when the caller knows better than "now". See AddKnowledgeInput. */
  timestamp?: number;
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
  // The whole row, not only its sentence: for a case, the moment is the identity
  // and two moments that read alike are allowed to both be true. See identityOf.
  const duplicate = await findDuplicate(input, {
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
        `${input.topic}. ${identityOf(input).text}`,
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
