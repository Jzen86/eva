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
import { getAllKnowledge, getKnowledgeCount, type KnowledgeRow } from "./knowledge.js";
import { loadHistory, extractText } from "./conversations.js";
import { getDB } from "./db.js";
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
 * Sessions since boot that produced no write. Module-level on purpose — but only
 * this counter, deliberately NOT the zone: the zone is derived from how many
 * study insights are already stored, so a restart cannot replay the same zone.
 * A module-level cursor did exactly that, and the 18:33 restart sent two
 * consecutive sessions back to "она сама" instead of rotating.
 */
let noWriteSessions = 0;

/**
 * Next zone = study entries already stored + sessions skipped since boot.
 * A written session bumps the stored count, so the rotation advances on its own;
 * `noWriteSessions` covers the sessions that returned null or a duplicate, which
 * would otherwise stick the cursor on the same empty zone forever.
 */
function nextZone(known: KnowledgeRow[]): (typeof ZONES)[number] {
  const studyDone = known.filter((k) => k.source === STUDY_SOURCE).length;
  return ZONES[(studyDone + noWriteSessions) % ZONES.length];
}

/** Token-overlap ratio above which an insight counts as already known. */
const DEDUPE_THRESHOLD = 0.6;

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
      trimKnowledge(opts.maxKnowledge);
      return { ran: true, wrote: false, zone, error: generated.error, report: "" };
    }

    const { topic, insight, reason, known } = generated;

    if (!topic || !insight) {
      markStudyComplete();
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge);
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
    if (isDuplicate(insight, known)) {
      markStudyComplete();
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge);
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

    // Reuse the upstream session runner. The callback just hands back what we
    // already generated, so learning.ts needs no changes.
    await runStudySession(opts.learning, async () => ({ topic, insight }));
    trimKnowledge(opts.maxKnowledge);

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

/** Lowercase, drop punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words (drop 1-3 letter noise like "и", "не", "он"). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split(" ")
      .map((w) => w.replace(/(?:ов|ий|ая|ое|ые|ам|ах|ом|ем|ешь|ю)$/u, ""))
      .filter((w) => w.length > 3),
  );
}

/** Share of the smaller set contained in the larger (containment, not Jaccard). */
function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * True when the candidate insight says something the base already says.
 * Compares against every row, not just the prompt window — the window is only
 * what the model saw, the dedupe has to cover what actually got stored.
 */
function isDuplicate(insight: string, known: KnowledgeRow[]): boolean {
  const candidate = normalize(insight);
  if (!candidate) return false;
  const candidateTokens = tokenize(candidate);
  if (!candidateTokens.size) return false;

  for (const row of known) {
    const existing = normalize(row.insight ?? "");
    if (!existing) continue;
    if (existing === candidate) return true;
    if (containment(candidateTokens, tokenize(existing)) >= DEDUPE_THRESHOLD) return true;
  }
  return false;
}

/**
 * Enforce the max_knowledge cap (nothing else in the codebase does), but by
 * source: chat-driven memory writes are far denser than study sessions, so a
 * plain recency trim would delete the study insights first — exactly backwards.
 * Study rows keep the whole budget; everything else fills what's left.
 */
function trimKnowledge(max: number): void {
  if (max <= 0) return;
  try {
    const db = getDB();
    const total = getKnowledgeCount();
    if (total <= max) return;

    const studyRow = db
      .prepare("SELECT COUNT(*) AS count FROM knowledge WHERE source IS ?")
      .get(STUDY_SOURCE) as { count: number };
    const studyCount = studyRow.count ?? 0;
    const studyKeep = Math.min(studyCount, max);
    const otherKeep = Math.max(0, max - studyKeep);

    db.prepare(
      `DELETE FROM knowledge
       WHERE source IS ?
         AND id NOT IN (
           SELECT id FROM knowledge
           WHERE source IS ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ?
         )`,
    ).run(STUDY_SOURCE, STUDY_SOURCE, studyKeep);

    db.prepare(
      `DELETE FROM knowledge
       WHERE source IS NOT ?
         AND id NOT IN (
           SELECT id FROM knowledge
           WHERE source IS NOT ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ?
         )`,
    ).run(STUDY_SOURCE, STUDY_SOURCE, otherKeep);
  } catch (err) {
    console.error("⚠️ study: не удалось почистить базу знаний:", err instanceof Error ? err.message : err);
  }
}
