/**
 * Study session runner — background self-learning glue.
 *
 * A "session" = read the knowledge base + the recent conversation, ask a small
 * LLM for exactly ONE new insight, store it. If the model answers "nothing new",
 * nothing is written (keeps the base clean — top-5 hits get injected into every
 * prompt by the engine, so junk in = junk everywhere).
 *
 * This is the piece that was missing: `runStudySession` in ./learning.js takes a
 * `generateInsight` callback and nothing in the single-mode runtime provided one.
 *
 * Hardening added 2026-09-25 after the first live runs:
 *  - zone rotation (the first prompt mandated "insight must be about the owner",
 *    so the base became 100% owner-facts; the model never picks, the code does)
 *  - hard dedupe in code (the "do not repeat" rule was a request, not a check)
 *  - source-aware trim (plain recency trim flushed study rows first, because her
 *    chat-driven memory writes are always denser and newer)
 */

import {
  runStudySession,
  shouldStudy,
  markStudyComplete,
  type LearningConfig,
} from "./learning.js";
import {
  getAllKnowledge,
  getKnowledgeCount,
  getZoneCoverage,
  getZoneLastStudied,
  markZoneStudied,
  trimKnowledge,
  type KnowledgeRow,
} from "./knowledge.js";
import { findLexicalDuplicate, learnInsight, type EmbeddingEndpoint } from "./dedup.js";
import { loadHistory, extractText } from "./conversations.js";
import type { LLMClient, LLMMessage } from "../llm/types.js";

/** Knowledge entries fed to the model as "what I already know". */
const DEFAULT_KNOWLEDGE_WINDOW = 20;
/** Conversation messages fed to the model as raw material. */
const DEFAULT_CHAT_WINDOW = 20;
/** Max chars per conversation message in the prompt (prompt-size guard). */
const MAX_CHAT_CHARS = 700;

/** Source tag written by the study loop itself. */
const STUDY_SOURCE = "study_session";

/**
 * Coverage zones, cycled one per session. Round-robin is deterministic on
 * purpose: asking the model to "vary topics" reliably produces the same topic
 * forever, so the rotation is decided here instead.
 */
const ZONES = [
  {
    name: "владелец",
    hint: "его биография, привычки, предпочтения, что его радует или бесит, как он общается и на что реагирует",
  },
  {
    name: "она сама",
    hint: "её собственная работа: как она отвечает, какие у неё сильные и слабые стороны, её манера, характер, настроение",
  },
  {
    name: "сервер и задрот",
    hint: "сервер, бот-задрот, сервисы, логи, конфиги, обслуживание, симптомы поломок и найденные причины",
  },
  {
    name: "её ошибки и уроки",
    hint: "где она в последнем разговоре сработала плохо или наоборот хорошо, какие выводы и правила из этого следуют",
  },
] as const;

/**
 * Sessions since boot that produced no write.
 *
 * Kept in the database alongside the zone cursor, not in a module variable: a
 * module-level counter resets on every restart, which is what once sent two
 * consecutive sessions back to the same empty zone.
 */
let noWriteSessions = 0;

/**
 * Which zone to study next.
 *
 * The emptiest one wins, and the tie goes to whatever was studied longest ago.
 * Round-robin was simpler and wrong: it kept handing out the same zone once the
 * counts drifted, and it had no idea that "сервер и задрот" had nothing in it
 * at all. Sorting by coverage is what makes the rotation aim somewhere.
 */
function pickZone(known: KnowledgeRow[]): (typeof ZONES)[number] {
  const coverage = getZoneCoverage();
  const lastStudied = getZoneLastStudied();
  const never = 0;

  let best: (typeof ZONES)[number] = ZONES[0];
  let bestCount = Number.MAX_SAFE_INTEGER;
  let bestSeen = Number.MAX_SAFE_INTEGER;

  for (const zone of ZONES) {
    // Entries that predate the zone column carry no zone at all, so they are
    // spread across the zones rather than left out of the count entirely.
    const count = coverage.get(zone.name) ?? 0;
    const unzoned = known.filter(
      (k) => k.source === STUDY_SOURCE && !k.zone,
    ).length;
    const score = count + unzoned / ZONES.length;
    const seen = lastStudied[zone.name] ?? never;

    if (score < bestCount || (score === bestCount && seen < bestSeen)) {
      best = zone;
      bestCount = score;
      bestSeen = seen;
    }
  }
  return best;
}

/**
 * Next zone, with the skipped sessions folded in.
 *
 * `noWriteSessions` matters because a zone that produced nothing twice running
 * is being refused by the model, not merely empty — advancing past it is what
 * keeps one dead prompt from blocking the whole rotation.
 */
function nextZone(known: KnowledgeRow[]): (typeof ZONES)[number] {
  const zone = pickZone(known);
  if (noWriteSessions >= 2) {
    // Refused repeatedly: take the next emptiest rather than retrying the same.
    const seen = getZoneLastStudied();
    const others = ZONES.filter((z) => z.name !== zone.name);
    return others.sort((a, b) => (seen[a.name] ?? 0) - (seen[b.name] ?? 0))[0] ?? zone;
  }
  return zone;
}

export interface StudyRunOptions {
  /** Clients tried in order: dedicated study model first, then the fast model. */
  clients: LLMClient[];
  agentName: string;
  ownerName?: string;
  /** Chat user id — used to pull the recent conversation. */
  userId: string;
  learning: LearningConfig;
  maxKnowledge: number;
  knowledgeWindow?: number;
  chatWindow?: number;
  /**
   * Optional embedding endpoint. Present it and every insight is compared
   * semantically against what is stored and written with its vector; leave it
   * out and the run behaves exactly as it did before, lexical dedup only.
   */
  embedding?: EmbeddingEndpoint | null;
}

export interface StudyRunResult {
  /** False when the cooldown timer said "not yet" or a session was already running. */
  ran: boolean;
  wrote: boolean;
  topic?: string;
  insight?: string;
  reason?: string;
  /** Coverage zone this session was assigned. */
  zone?: string;
  /** Human-readable summary for the chat / log. */
  report: string;
  error?: string;
}

/** Guards against overlapping sessions piling up duplicate insights. */
let inFlight = false;
let sessionCount = 0;

/** Reset the cooldown on boot so a restart doesn't instantly fire a session. */
export function primeStudyTimer(): void {
  markStudyComplete();
}

/** Cooldown check + no-op result when it's not time yet. */
export async function runStudyIfDue(opts: StudyRunOptions): Promise<StudyRunResult> {
  if (inFlight) {
    return { ran: false, wrote: false, report: "" };
  }
  if (!shouldStudy(opts.learning)) {
    return { ran: false, wrote: false, report: "" };
  }
  return runStudy(opts);
}

/**
 * Run one study session: generate an insight, store it, trim the base.
 * Always resets the cooldown, even when the model has nothing new to say —
 * otherwise a "nothing new" answer would re-fire the LLM on every tick.
 */
export async function runStudy(opts: StudyRunOptions): Promise<StudyRunResult> {
  if (inFlight) {
    return { ran: false, wrote: false, report: "" };
  }
  inFlight = true;
  try {
    const generated = await generateInsight(opts);
    const zone = generated.zone;

    if (generated.error) {
      markStudyComplete();
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);
      return { ran: true, wrote: false, zone, error: generated.error, report: "" };
    }

    const { topic, insight, reason, known } = generated;

    if (!topic || !insight) {
      markStudyComplete();
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);
      return {
        ran: true,
        wrote: false,
        zone,
        reason,
        report: `📚 Сессия #${sessionCount} [${zone}]: новых выводов нет${reason ? ` — ${reason}` : ""}`,
      };
    }

    // Hard dedupe: the prompt asks the model not to repeat itself, which is a
    // request. This is the check. A false positive only wastes one cheap
    // session; a false negative permanently pollutes every future prompt.
    //
    // Only the lexical half runs here. The semantic half needs an embedding
    // endpoint, which lives on the study options, and it is applied in the
    // writer below so a memory is never stored without a vector when one is
    // available.
    const duplicate = findLexicalDuplicate(insight, known);
    if (duplicate) {
      markStudyComplete();
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);
      return {
        ran: true,
        wrote: false,
        topic,
        insight,
        zone,
        reason: "такой вывод уже есть в базе",
        report: `📚 Сессия #${sessionCount} [${zone}]: «${topic}» — такой вывод уже есть, не пишу дубль`,
      };
    }

    // Reuse the upstream session runner. The generator hands back what we
    // already produced; the writer is passed in so the write goes through the
    // same dedup-and-embed path every other memory takes.
    const result = await runStudySession(
      opts.learning,
      async () => ({ topic, insight }),
      // Always passed, not only when embeddings are on: the zone is stamped on
      // the row either way, and it is what the next rotation reads.
      (entry) => learnInsight({ ...entry, zone }, {
        known,
        embedding: opts.embedding ?? null,
      }),
    );
    trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);

    // The semantic check can still refuse the insight after the lexical one let
    // it through, so the report follows what actually happened.
    if (!result.written) {
      sessionCount++;
      noWriteSessions++;
      return {
        ran: true,
        wrote: false,
        topic,
        insight,
        zone,
        reason: result.reason,
        report: `📚 Сессия #${sessionCount} [${zone}]: «${topic}» — ${result.reason}`,
      };
    }

    noWriteSessions = 0;
    markStudyComplete();
    sessionCount++;
    const total = getKnowledgeCount();
    return {
      ran: true,
      wrote: true,
      topic,
      insight,
      zone,
      report: [
        `📚 Сессия #${sessionCount} · зона: ${zone}`,
        `Тема: ${topic}`,
        `Вывод: ${insight}`,
        `База знаний: ${total}`,
      ].join("\n"),
    };
  } catch (err) {
    markStudyComplete();
    const message = err instanceof Error ? err.message : String(err);
    return { ran: true, wrote: false, error: message, report: "" };
  } finally {
    inFlight = false;
  }
}

interface Generated {
  topic: string | null;
  insight: string | null;
  reason?: string;
  error?: string;
  /** Zone this session was assigned. */
  zone: string;
  /** Knowledge snapshot the prompt was built from — reused for the dedupe check. */
  known: KnowledgeRow[];
}

/** Ask the LLM for one new insight. Tries each client in order. */
async function generateInsight(opts: StudyRunOptions): Promise<Generated> {
  const known = getAllKnowledge();
  const zone = nextZone(known);
  // Recorded before the call, not after: a session that produced nothing still
  // counts as having looked at this zone, otherwise the tie-break would send
  // the next session straight back to a zone that clearly refuses to produce.
  markZoneStudied(zone.name);
  const messages = buildStudyMessages(opts, zone, known);
  let lastError = "";

  for (const client of opts.clients) {
    try {
      const res = await client.chat(messages);
      const parsed = parseInsightJson(res.text ?? "");
      if (parsed) return { ...parsed, zone: zone.name, known };
      lastError = "не удалось разобрать ответ модели как JSON";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    topic: null,
    insight: null,
    error: lastError || "нет доступных клиентов",
    zone: zone.name,
    known,
  };
}

function buildStudyMessages(
  opts: StudyRunOptions,
  zone: (typeof ZONES)[number],
  known: KnowledgeRow[],
): LLMMessage[] {
  const knowledge = known.slice(0, opts.knowledgeWindow ?? DEFAULT_KNOWLEDGE_WINDOW);
  const chat = loadChat(opts.userId, opts.chatWindow ?? DEFAULT_CHAT_WINDOW);

  const system = [
    `Ты — ${opts.agentName}, AI-компаньон. Сейчас идёт твоя фоновая учебная сессия.`,
    "",
    `Задача: посмотреть на свои накопленные знания и свежую переписку с владельцем`,
    `и вывести РОВНО ОДИН новый полезный вывод, которого в базе ещё нет.`,
    "",
    "Жёсткие правила:",
    "1. Отвечай ТОЛЬКО валидным JSON. Никаких пояснений, никаких markdown-заглушек вокруг JSON.",
    '2. Формат: {"topic": "тема 2-4 слова", "insight": "вывод 1-3 предложения", "reason": "почему это новое"}',
    '3. Если в переписке и базе нет ничего стоящего — верни {"topic": null, "insight": null, "reason": "причина"}.',
    "4. НЕ повторяй то, что уже есть в базе: полный список уже известных выводов — ниже, в уже_известно.",
    "   Перефразировка НЕ считается новым. Если там уже есть вывод про то же самое другими",
    "   словами — обязан вернуть null, даже когда формулировки не совпадают. Сравнивай смысл, не слова.",
    "   Короткий чек-лист тем, которые нельзя дублировать: не_дублировать_эти_темы.",
    `5. Эта сессия посвящена ОДНОЙ зоне: «${zone.name}» — ${zone.hint}.`,
    "   Про другие зоны в этот раз не пиши вообще. Нет материала по своей зоне —",
    "   честно верни null, это нормально и не считается ошибкой.",
    "6. Ничего не выдумывай: только то, что реально есть в переписке или в базе.",
    "7. Пиши на русском, как внутреннюю заметку. Без обращений к владельцу, он этого не видит.",
  ].join("\n");

  const payload = {
    зона_этой_сессии: zone.name,
    что_это_значит: zone.hint,
    не_дублировать_эти_темы: knowledge.map((k: KnowledgeRow) => k.topic),
    уже_известно: knowledge.map((k: KnowledgeRow) => ({ topic: k.topic, insight: k.insight })),
    свежая_переписка: chat,
  };

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload, null, 1) },
  ];
}

/** Recent user/assistant messages, oldest first, as plain text. */
function loadChat(userId: string, limit: number): Array<{ role: string; text: string }> {
  let messages: LLMMessage[];
  try {
    messages = loadHistory(userId, limit * 3).messages;
  } catch {
    return [];
  }

  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: truncate(plainText(m.content), MAX_CHAT_CHARS) }))
    .filter((m) => m.text.length > 0)
    .slice(-limit);
}

/** Content may be a plain string or a JSON-serialized ContentPart array. */
function plainText(content: string | unknown): string {
  const raw = extractText(content as string);
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      return extractText(JSON.parse(trimmed));
    } catch {
      return raw;
    }
  }
  return raw;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Lenient JSON extraction: strips ``` fences, takes the outermost {...}. */
function parseInsightJson(
  raw: string,
): { topic: string | null; insight: string | null; reason?: string } | null {
  if (!raw) return null;

  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const topic = typeof obj.topic === "string" && obj.topic.trim() ? obj.topic.trim() : null;
  const insight = typeof obj.insight === "string" && obj.insight.trim() ? obj.insight.trim() : null;
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined;

  return { topic, insight, reason };
}

// The dedupe comparison and the trim used to live here as local functions. Both
// are shared logic now — see memory/dedup.ts and memory/knowledge.ts — because
// the study prompt is the only part of this file that is off limits, not the
// bookkeeping around it. The old local version had a real defect: it divided by
// the smaller token set, so a long new insight that merely mentioned a known word
// scored 1.0 and was discarded as a repeat.
