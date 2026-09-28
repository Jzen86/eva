/**
 * Study session runner — background self-learning glue.
 *
 * A "session" = read the knowledge base + everything in the transcript since the
 * last session, ask a small LLM what happened in it, store that. If the model
 * answers "nothing happened", nothing is written (keeps the base clean — the hits
 * get injected into every prompt by the engine, so junk in = junk everywhere).
 *
 * What a session is allowed to write is the load-bearing part. It used to ask
 * for "ровно один новый полезный вывод", and the base filled with conclusions
 * phrased as instructions — "не стоит включать оборону", "обязана отбрасывать
 * парную похвалу" — which a model then obeys instead of weighing. It asks for
 * facts and cases now, and two checks in code drop what the prompt failed to.
 *
 * Hardening added 2026-09-25 after the first live runs:
 *  - zone rotation (the first prompt mandated "insight must be about the owner",
 *    so the base became 100% owner-facts; the model never picks, the code does)
 *  - hard dedupe in code (the "do not repeat" rule was a request, not a check)
 *  - source-aware trim (plain recency trim flushed study rows first, because her
 *    chat-driven memory writes are always denser and newer)
 *  - a persistent read cursor instead of a newest-N window, so a moment is read
 *    because it has not been read, not because the chat happened to be quiet when
 *    the session fired
 */

import {
  shouldStudy,
  markStudyComplete,
  type LearningConfig,
} from "./learning.js";
import {
  getAllKnowledge,
  getKnowledgeCount,
  getZoneCoverage,
  getZoneLastStudied,
  isCase,
  markZoneStudied,
  relativeAge,
  trimKnowledge,
  type KnowledgeRow,
} from "./knowledge.js";
import { findLexicalDuplicate, learnInsight, type EmbeddingEndpoint } from "./dedup.js";
import {
  extractText,
  loadSummary,
  messagesSince,
  studyStart,
  setStudyCursor,
} from "./conversations.js";
import type { LLMClient, LLMMessage } from "../llm/types.js";

/** Knowledge entries fed to the model as "what I already know". */
const DEFAULT_KNOWLEDGE_WINDOW = 20;
/** Max chars per conversation message in the prompt (prompt-size guard). */
const MAX_CHAT_CHARS = 700;
/**
 * Rows one session may pull from the transcript at once.
 *
 * Not a coverage limit — the cursor means nothing is skipped, only deferred.
 * It bounds memory on the first run after a long outage, when the gap can be
 * tens of thousands of messages: four hundred rows drain in a couple of runs and
 * the alternative is loading the whole table to keep twelve thousand characters.
 */
const MAX_CHAT_ROWS = 400;
/**
 * Total budget for the raw transcript in one study prompt.
 *
 * Sized to what the old twenty-message window cost, so moving from a window to a
 * cursor does not grow the prompt — the same budget just buys the messages that
 * have not been read instead of the messages that happen to be newest.
 */
const MAX_CHAT_TOTAL_CHARS = 12000;
/**
 * Cap for the rolling summary. Generous relative to one message, because it
 * stands in for everything that has already scrolled out of the window — but
 * still bounded, since a runaway summary would push the whole prompt over.
 */
const MAX_SUMMARY_CHARS = 4000;

/** Source tag written by the study loop itself. */
const STUDY_SOURCE = "study_session";

/**
 * Coverage zones, cycled one per session. Round-robin is deterministic on
 * purpose: asking the model to "vary topics" reliably produces the same topic
 * forever, so the rotation is decided here instead.
 *
 * Two hints used to ask for conclusions outright — "какие у неё сильные и слабые
 * стороны, её манера, характер" and "какие выводы и правила из этого следуют" —
 * and the base filled up accordingly: "Отказ от симметричной валидации",
 * "виртуальная пластичность", "итеративное самоопределение". Those are
 * self-descriptions, not things she can act on, and a model handed one of them
 * obeys it instead of weighing the moment. The hints now ask what happened.
 */
const ZONES = [
  {
    name: "владелец",
    hint: "его биография, привычки, что он любит и что его бесит, как он общается",
  },
  {
    name: "она сама",
    hint: "что она делает и говорит в разговоре: тон, шутки, границы, как реагирует на его настроение",
  },
  {
    name: "сервер и задрот",
    hint: "сервер, бот-задрот, сервисы, логи, конфиги, обслуживание, симптомы поломок и найденные причины",
  },
  {
    name: "её промахи",
    hint: "моменты, где она ответила неудачно, и как он это отметил. Уроков и правил не пиши — нужен сам момент и его реакция",
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
 * Run one study session: read what is new in the transcript, store what happened,
 * trim the base.
 *
 * Always resets the cooldown, even when the model has nothing new to say —
 * otherwise a "nothing new" answer would re-fire the LLM on every tick. Advances
 * the read cursor the same way, and only on a session that actually read
 * something; see `finish` below for why the two are one call.
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

    /**
     * Close a session that actually read something.
     *
     * Both halves move together or neither does: the cursor because the batch was
     * read and the model answered it, the cooldown because the run is over. A
     * session that errored resets the cooldown and leaves the cursor where it was
     * — nothing was read, so nothing may be marked as covered, and the next run
     * reads the same messages against a working model.
     *
     * One call rather than a line repeated in five places, because it was exactly
     * that before and one of the five had been forgotten: when every fact came
     * back as a duplicate, `markStudyComplete` was never reached and the LLM
     * re-fired on the next tick and on every tick after it.
     */
    const finish = (result: StudyRunResult): StudyRunResult => {
      setStudyCursor(opts.userId, generated.coveredTo);
      markStudyComplete();
      return result;
    };

    const window =
      generated.chatCount > 0
        ? ` · окно ${generated.chatCount}` +
          (generated.deferred > 0 ? ` (+${generated.deferred} в следующую сессию)` : "")
        : "";
    const { facts, reason, known } = generated;

    if (facts.length === 0) {
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);
      return finish({
        ran: true,
        wrote: false,
        zone,
        reason,
        report: `📚 Сессия #${sessionCount} [${zone}]${window}: записей нет${reason ? ` — ${reason}` : ""}`,
      });
    }

    // What the prompt cannot be trusted to enforce about itself. Both checks drop
    // rather than repair: a conclusion in the base goes into every future prompt,
    // and a case with a guessed half is indistinguishable from a memory of
    // something that happened. An empty session costs one cheap run; a bad row
    // costs every conversation after it.
    const accepted: Array<{ f: StudyFact; c: CaseFields }> = [];
    const dropped: string[] = [];
    for (const f of facts) {
      if (looksLikePrescription(f.fact)) {
        dropped.push(`«${truncate(f.fact, 60)}» — это правило, а не факт`);
        continue;
      }
      const c = caseFieldsOf(f);
      if (c.kind === "partial") {
        dropped.push(`«${truncate(f.fact, 60)}» — случай заполнен наполовину`);
        continue;
      }
      accepted.push({ f, c });
    }

    if (accepted.length === 0) {
      sessionCount++;
      noWriteSessions++;
      trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);
      return finish({
        ran: true,
        wrote: false,
        zone,
        reason: "всё, что вернула модель, отброшено фильтром",
        report:
          `📚 Сессия #${sessionCount} [${zone}]${window}: отброшено ${dropped.length}\n` +
          dropped.map((d) => `  · ${d}`).join("\n"),
      });
    }

    // The lexical half of the dedupe, run here as a check rather than a request.
    // Only the lexical half: the semantic half needs an embedding endpoint and
    // runs inside learnInsight below, so a memory is never stored without a
    // vector when one is available.
    //
    // `known` is re-read after every write, so two near-identical facts in one
    // session cannot both get in — they are compared against each other, not
    // only against what was there before the session started. A false positive
    // only wastes one cheap session; a false negative permanently pollutes every
    // future prompt.
    const written: Array<{ topic: string; fact: string; c: CaseFields }> = [];
    const refused: string[] = [];
    for (const { f, c } of accepted) {
      // The case fields go into the check, not only the sentence. Without them a
      // case is measured like a fact, and two moments with the same trigger and
      // opposite reactions collapse into one — which is the rule this base is
      // built not to store. See identityOf.
      if (
        findLexicalDuplicate(
          {
            insight: f.fact,
            her_move: c.kind === "full" ? c.her_move : null,
            context: c.kind === "full" ? c.context : null,
            his_reaction: c.kind === "full" ? c.his_reaction : null,
            conclusion: f.conclusion,
          },
          getAllKnowledge(),
        )
      ) {
        refused.push(`«${truncate(f.fact, 60)}» — уже есть в базе`);
        continue;
      }

      const outcome = await learnInsight(
        {
          topic: f.topic,
          insight: f.fact,
          source: STUDY_SOURCE,
          zone,
          // Dated by the conversation, not by the run. A session reading a
          // backfill is reconstructing days-old talk, and stamping it today
          // would make "мы говорили об этом вчера" a falsehood the base tells
          // about itself.
          timestamp: generated.coveredAt,
          ...(f.conclusion ? { conclusion: f.conclusion } : {}),
          ...(c.kind === "full"
            ? { her_move: c.her_move, context: c.context, his_reaction: c.his_reaction }
            : {}),
        },
        { known: getAllKnowledge(), embedding: opts.embedding ?? null },
      );

      if (outcome.written) {
        written.push({ topic: f.topic, fact: f.fact, c });
      } else {
        refused.push(`«${truncate(f.fact, 60)}» — ${outcome.reason}`);
      }
    }

    trimKnowledge(opts.maxKnowledge, STUDY_SOURCE);

    if (written.length === 0) {
      sessionCount++;
      noWriteSessions++;
      return finish({
        ran: true,
        wrote: false,
        zone,
        reason: "ничего нового",
        report:
          `📚 Сессия #${sessionCount} [${zone}]${window}: нового нет\n` +
          refused.map((r) => `  · ${r}`).join("\n"),
      });
    }

    noWriteSessions = 0;
    sessionCount++;
    const total = getKnowledgeCount();
    return finish({
      ran: true,
      wrote: true,
      zone,
      report: [
        `📚 Сессия #${sessionCount} · зона: ${zone}${window} · записано ${written.length} из ${facts.length}`,
        ...written.map((w) => {
          const head = `· ${w.topic}: ${w.fact}`;
          return w.c.kind === "full"
            ? `${head}\n    состояние: ${w.c.context} → он: ${w.c.his_reaction}`
            : head;
        }),
        ...refused.map((r) => `  (отброшено) ${r}`),
        ...dropped.map((d) => `  (отброшено) ${d}`),
        `База знаний: ${total}`,
      ].join("\n"),
    });
  } catch (err) {
    markStudyComplete();
    const message = err instanceof Error ? err.message : String(err);
    return { ran: true, wrote: false, error: message, report: "" };
  } finally {
    inFlight = false;
  }
}

interface Generated {
  facts: StudyFact[];
  reason?: string;
  error?: string;
  /** Zone this session was assigned. */
  zone: string;
  /** Knowledge snapshot the prompt was built from — the dedupe baseline. */
  known: KnowledgeRow[];
  /** How far the cursor may move once this session is over. See loadChatSince. */
  coveredTo: number;
  /** When the last message read was sent — what the written rows are dated. */
  coveredAt: number;
  /** Messages of transcript this session actually read. */
  chatCount: number;
  /** Read-but-not-shown messages the budget pushed to the next session. */
  deferred: number;
}

/** Ask the LLM what happened. Tries each client in order. */
async function generateInsight(opts: StudyRunOptions): Promise<Generated> {
  const known = getAllKnowledge();
  const zone = nextZone(known);
  // Recorded before the call, not after: a session that produced nothing still
  // counts as having looked at this zone, otherwise the tie-break would send
  // the next session straight back to a zone that clearly refuses to produce.
  markZoneStudied(zone.name);
  const built = buildStudyMessages(opts, zone, known);
  let lastError = "";

  for (const client of opts.clients) {
    try {
      const res = await client.chat(built.messages);
      const parsed = parseStudyJson(res.text ?? "");
      if (parsed) {
        return {
          ...parsed,
          zone: zone.name,
          known,
          coveredTo: built.coveredTo,
          coveredAt: built.coveredAt,
          chatCount: built.chatCount,
          deferred: built.deferred,
        };
      }
      lastError = "не удалось разобрать ответ модели как JSON";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    facts: [],
    error: lastError || "нет доступных клиентов",
    zone: zone.name,
    known,
    coveredTo: built.coveredTo,
    coveredAt: built.coveredAt,
    chatCount: built.chatCount,
    deferred: built.deferred,
  };
}

function buildStudyMessages(
  opts: StudyRunOptions,
  zone: (typeof ZONES)[number],
  known: KnowledgeRow[],
): {
  messages: LLMMessage[];
  coveredTo: number;
  coveredAt: number;
  chatCount: number;
  deferred: number;
} {
  const knowledge = known.slice(0, opts.knowledgeWindow ?? DEFAULT_KNOWLEDGE_WINDOW);
  const chat = loadChatSince(opts.userId, studyStart(opts.userId));

  const system = [
    `Ты — ${opts.agentName}, AI-компаньон. Сейчас идёт твоя фоновая учебная сессия.`,
    "",
    `Задача: посмотреть на свежую переписку с владельцем и записать в базу то, что там`,
    `произошло. Факты, темы разговоров и случаи — не выводы.`,
    "",
    "Жёсткие правила:",
    "1. Отвечай ТОЛЬКО валидным JSON. Никаких пояснений, никаких markdown-заглушек вокруг JSON.",
    '2. Формат: {"facts": [{"topic": "тема", "fact": "что было", "conclusion": null,',
    '   "her_move": null, "context": null, "his_reaction": null}]}',
    "   Три поля случая — либо все строками, либо все null. Половины быть не может.",
    "   conclusion — итог: чем кончилось, что решили, к чему пришли. Пусто, если ничем.",
    "3. Сколько записей — столько и есть по-настоящему. Обычно одна-три, но если в переписке",
    '   было больше разного — пиши больше, ничего не выкидывая. Если не произошло ничего',
    '   стоящего — верни {"facts": [], "reason": "причина"}.',
    "4. Три вида записей, выбирай подходящий:",
    "   а) О ЧЁМ ГОВОРИЛИ — тема разговора и что по ней было. Чаще всего нужен именно он.",
    '      topic = короткое имя темы, 1-4 слова («кошки», «спор о нейросетях», «сервер»),',
    "      fact = о чём говорили, что он рассказал, к чему пришли.",
    '      «летал в Саратов на самолёте, вспоминал посадку в грозу»',
    '      «сравнивали Gemini и DeepSeek, он остался на Gemini»',
    "      Даже если по теме ничего не решили — сама тема уже стоит записи.",
    "   б) ФАКТ О ЧЕЛОВЕКЕ — утверждение о нём или о ней, проверяемое по переписке.",
    '      «не любит айфоны», «в Саратове, UTC+4», «она любит подкалывать».',
    "   в) СЛУЧАЙ — она что-то сделала, он отреагировал. Тогда все три поля:",
    "      her_move = что она сделала или сказала;",
    "      context = в каком он был состоянии (занят, весёлый, поссорился, устал, выпил);",
    "      his_reaction = как он отреагировал (подхватил, огрызнулся, отшутился, замолчал,",
    "      попросил больше так не делать, сдался, согласился).",
    "      context обязателен: без него запись прочитается как правило, а правила здесь не хранят.",
    "   В любой записи описание должно быть конкретным. Имя, число, цвет, версия, место,",
    "   срок — что угодно, за что потом зацепится память.",
    '      Плохо: «рассказывал про кошку», «обсуждали нейросети» — вспомнить по этому нечего,',
    "      такая строка занимает место и не даёт ничего.",
    '      Хорошо: «кошку зовут Муська, трёхцветная, подобрал на улице, спит на клавиатуре».',
    '      Хорошо: «сравнивали Gemini и DeepSeek, пробовал оба на своём коде».',
    "   Если конкретного не назвать ни одного слова — записывать нечего, не пиши строку.",
    "5. conclusion (итог) ставь только там, где разговор или случай чем-то кончился:",
    "   что решили, на чём он остановился, чем спор закончился. У факта о человеке итога",
    "   нет — оставь null. Итог принадлежит именно этой записи: другой спор в другой день",
    "   мог кончиться наоборот, и это нормально. Поэтому пиши итог вместе с тем, из чего он",
    "   вышел, а не «на будущее» — не «не спорь с ним», а «сравнивали Gemini и DeepSeek,",
    "   он остался на Gemini».",
    "6. ГЛАВНОЕ. Выводы и правила не пиши. Ни «вывод:», ни «не надо», ни «не стоит»,",
    "   ни «значит надо», ни «следует», ни «полагается». Если ты не можешь назвать конкретный",
    "   момент, случай или тему разговора — это вывод, и его писать не надо. Лучше facts: [].",
    "7. Смотри не только на поправки. Правки видны первыми, потому что он поправляет. Ищи так",
    "   же: где он был доволен, где смеялся, где она была права и настояла, где он сдался, где",
    "   он сам о чём-то попросил. База, где записаны только её промахи — это список её ошибок,",
    "   и по нему она учится только соглашаться.",
    "8. Если новое противоречит старому из уже_известно — это разные моменты, а не исправление.",
    "   Запиши новое. Старое не трогай и не переписывай.",
    "9. Не повторяй то, что уже есть в базе: полный список — ниже, в уже_известно.",
    "   Перефразировка НЕ считается новым. Если там уже есть то же самое другими словами —",
    "   не пиши это, даже когда формулировки не совпадают. Сравнивай смысл, не слова.",
    "   Короткий чек-лист тем, которые нельзя дублировать: не_дублировать_эти_темы.",
    "   Но та же тема в другой день — это новое: «говорили о самолётах» бывает и трижды.",
    `10. Эта сессия посвящена ОДНОЙ зоне: «${zone.name}» — ${zone.hint}.`,
    "   Про другие зоны в этот раз не пиши вообще. Нет материала по своей зоне —",
    "   честно верни facts: [], это нормально и не считается ошибкой.",
    "   Исключение: темы разговоров пиши всегда, какой бы зона ни была.",
    "11. Ничего не выдумывай: только то, что реально есть в переписке, в сводке или в базе.",
    "12. Пиши на русском, как внутреннюю заметку. Без обращений к владельцу, он этого не видит.",
    "13. сводка_старой_переписки — это то, что было раньше, чем свежая_переписка. Паттерны,",
    "   проявившиеся за недели, видны там, а не в последних сообщениях. Учитывай её наравне.",
    "14. Дату и время ставить не надо — система проставит сама по времени сообщений.",
  ].join("\n");

  const payload = {
    зона_этой_сессии: zone.name,
    что_это_значит: zone.hint,
    не_дублировать_эти_темы: knowledge.map((k: KnowledgeRow) => k.topic),
    // Shaped the way the answer prompt sees it, case fields included, so a study
    // run recognises an existing case the same way a conversation would.
    уже_известно: knowledge.map((k: KnowledgeRow) => ({
      topic: k.topic,
      fact: k.insight,
      // When it was. The same subject on another day is new material, and this is
      // what lets the model tell the two apart instead of refusing the second as
      // a repeat of the first.
      когда: relativeAge(k.timestamp),
      ...(k.conclusion.trim() ? { итог: k.conclusion } : {}),
      ...(isCase(k)
        ? {
            her_move: k.her_move,
            context: k.context,
            his_reaction: k.his_reaction,
          }
        : {}),
    })),
    // Older than the window below. Patterns that took weeks to show up live
    // here and nowhere else.
    сводка_старой_переписки: chat.summary,
    свежая_переписка: chat.messages,
  };

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload, null, 1) },
    ],
    coveredTo: chat.coveredTo,
    coveredAt: chat.coveredAt,
    chatCount: chat.messages.length,
    deferred: chat.deferred,
  };
}

/**
 * Everything the transcript holds since the last session, oldest first, as plain
 * text, plus the rolling summary of everything older.
 *
 * The summary is half the point. Without it a session sees only what has not been
 * read yet, and a pattern that took a month to emerge — how the owner actually
 * talks, what he circles back to, what annoys him — would be invisible exactly
 * when it became visible. The table existed the whole time; the study prompt just
 * threw the value away.
 *
 * The cursor is the other half. Taking the newest N messages is the wrong axis:
 * it makes what a session reads a function of how busy the chat was, so a
 * correction landing in a quiet hour is read and one landing in a loud hour is
 * skipped, and neither has anything to do with whether the moment mattered. The
 * cursor makes it a function of what has been read, which is the only question
 * worth asking.
 *
 * `coveredTo` is what the cursor may advance to. The batch is kept oldest-first
 * and the pointer moves to the last message kept, and the two have to agree: the
 * cursor is a high-water mark, so everything up to it counts as read. A batch cut
 * from the front would leave the dropped messages below the mark and the cursor
 * claiming they had been read, which is the exact failure it exists to prevent.
 *
 * The overflow is then deferred, not dropped — the next session reads it — and
 * reported, so a chat that produces more than one budget an hour shows up as a
 * backlog instead of quietly falling behind.
 */
function loadChatSince(
  userId: string,
  sinceId: number,
): {
  messages: Array<{ role: string; text: string }>;
  summary: string | null;
  coveredTo: number;
  /** When the last message read was sent. Stamps the rows it produces. */
  coveredAt: number;
  deferred: number;
} {
  let rows: Array<{ id: number; role: string; content: string; timestamp: number }>;
  let summary: string | null = null;
  try {
    rows = messagesSince(userId, sinceId, MAX_CHAT_ROWS);
    summary = loadSummary(userId);
  } catch {
    return {
      messages: [],
      summary: null,
      coveredTo: sinceId,
      coveredAt: Math.floor(Date.now() / 1000),
      deferred: 0,
    };
  }

  const all = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      id: r.id,
      role: r.role,
      ts: r.timestamp,
      text: truncate(plainText(r.content), MAX_CHAT_CHARS),
    }))
    .filter((r) => r.text.length > 0);

  // Oldest first, and this is the opposite of what the digest below does with the
  // same budget. The digest is a static account of a stretch, and in an account
  // the newest end is the interesting one. This batch is a queue behind a read
  // pointer, and a pointer only moves forward: keeping the newest would push the
  // pointer past messages nobody read, while keeping the oldest makes the pointer
  // true and drains a backlog at one budget per session.
  let used = 0;
  let last = -1;
  for (let i = 0; i < all.length; i++) {
    used += all[i].text.length;
    // The first one always goes in, even alone over budget: a single message
    // longer than the whole budget would otherwise pin the pointer in place and
    // the session would re-read it for the rest of the install's life.
    if (used > MAX_CHAT_TOTAL_CHARS && i > 0) break;
    last = i;
  }
  const kept = all.slice(0, last + 1);

  return {
    messages: kept.map((r) => ({ role: r.role, text: r.text })),
    summary: summary ? keepNewest(summary, MAX_SUMMARY_CHARS) : null,
    coveredTo: kept.length > 0 ? kept[kept.length - 1].id : sinceId,
    coveredAt:
      kept.length > 0 ? kept[kept.length - 1].ts : Math.floor(Date.now() / 1000),
    deferred: all.length - kept.length,
  };
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

/**
 * Keep the end of the text, not the beginning.
 *
 * The digest used to be one rolling summary of a fixed size, so cutting its head
 * was never a decision. It is now a list of summarised stretches, oldest first,
 * and it grows: cut the head and a study run would see the first four thousand
 * characters of the conversation — the part already distilled into `knowledge`
 * many times over — and none of the part that just happened, which is the only
 * part a study run has not read yet.
 */
function keepNewest(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/** One thing to store: a fact about a person, or a case with all three fields. */
export interface StudyFact {
  topic: string;
  fact: string;
  her_move: string | null;
  context: string | null;
  his_reaction: string | null;
  /** How the conversation or the moment ended, when it ended in something. */
  conclusion: string | null;
}

/**
 * Phrasings that mean the model produced a rule instead of a fact.
 *
 * This is a blocklist of one observed failure, and it cannot be complete — which
 * is why the real filter is the study prompt. It is here because the prompt is a
 * request, and the base this repo shipped 45 rows of is what a request is worth:
 * "не стоит включать оборону", "не контрить, а потерпеть", "обязана отбрасывать
 * парную похвалу". A row the model wrote as a rule has to be caught somewhere that
 * is not the model, and a blocklist that fails open towards *not writing* is the
 * right side to fail on: a missed conclusion costs one cheap session, an accepted
 * one goes into every future prompt.
 */
const PRESCRIPTION_MARKERS = [
  "вывод",
  "вывод:",
  "не надо",
  "не нужно",
  "не стоит",
  "значит надо",
  "следует",
  "полагается",
  "правило:",
];

function looksLikePrescription(fact: string): boolean {
  const lower = fact.toLowerCase();
  return PRESCRIPTION_MARKERS.some((m) => lower.includes(m));
}

/**
 * The case fields, or why they are unusable.
 *
 * A half-filled case is dropped rather than completed. "She made a joke" with no
 * state recorded is the note that reads back as a rule, and guessing the missing
 * half is worse than losing it — the guess would be indistinguishable from a
 * memory of something that happened.
 */
type CaseFields =
  | { kind: "none" }
  | { kind: "partial" }
  | { kind: "full"; her_move: string; context: string; his_reaction: string };

function caseFieldsOf(f: StudyFact): CaseFields {
  const present = [f.her_move, f.context, f.his_reaction].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (present.length === 0) return { kind: "none" };
  if (present.length < 3) return { kind: "partial" };
  return {
    kind: "full",
    her_move: f.her_move!.trim(),
    context: f.context!.trim(),
    his_reaction: f.his_reaction!.trim(),
  };
}

/** Lenient JSON extraction: strips ``` fences, takes the outermost {...}. */
function parseStudyJson(
  raw: string,
): { facts: StudyFact[]; reason?: string } | null {
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

  const reason =
    typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined;

  // The old single-insight shape. Not a parse error — the model answered, just in
  // the format this base has moved off, and that answer was a conclusion by
  // construction. Naming it in the report is the point: the zone rotates and the
  // reason says why it produced nothing.
  if (!Array.isArray(obj.facts)) {
    if (typeof obj.topic === "string" || typeof obj.insight === "string") {
      return { facts: [], reason: "модель вернула вывод, а не факт" };
    }
    return { facts: [], reason };
  }

  const facts: StudyFact[] = [];
  for (const item of obj.facts) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const topic = typeof rec.topic === "string" ? rec.topic.trim() : "";
    const fact = typeof rec.fact === "string" ? rec.fact.trim() : "";
    if (!topic || !fact) continue;
    const str = (key: string): string | null =>
      typeof rec[key] === "string" && String(rec[key]).trim()
        ? String(rec[key]).trim()
        : null;
    facts.push({
      topic,
      fact,
      her_move: str("her_move"),
      context: str("context"),
      his_reaction: str("his_reaction"),
      conclusion: str("conclusion"),
    });
  }

  return { facts, reason };
}

// The dedupe comparison and the trim used to live here as local functions. Both
// are shared logic now — see memory/dedup.ts and memory/knowledge.ts — because
// the study prompt is the only part of this file that is off limits, not the
// bookkeeping around it. The old local version had a real defect: it divided by
// the smaller token set, so a long new insight that merely mentioned a known word
// scored 1.0 and was discarded as a repeat.
