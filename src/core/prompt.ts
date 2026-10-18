import { buildPersonalityPrompt } from "./personality.js";
import { gapPassage, stampMoment, stripReplyStamp } from "./memory/time-words.js";
import type { LiveMessage, TimeSeam } from "./memory/conversations.js";
import type { LLMMessage } from "./llm/types.js";

/**
 * The moment, in words a model can use.
 *
 * Both halves matter. The date tells her what "latest" means; the weekday tells
 * her whether a human would already know a thing that came out an hour ago, which
 * is the difference between looking it up and being smug about not looking it up.
 *
 * The offset is explicit and the label says so. The first version read the
 * server's clock and called it "server time" — which is true, useless, and
 * actively misleading: the box runs in UTC and the owner is four hours ahead, so
 * "today" rolled over at the wrong hour and every near-midnight answer was a day
 * out. A clock without a zone is not a clock.
 */
export function formatMoment(now: Date = new Date(), offsetHours = 4): string {
  const shifted = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  return (
    `${pad(shifted.getUTCDate())}.${pad(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()}, ` +
    `${days[shifted.getUTCDay()]}, ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} ` +
    `(UTC${offsetHours >= 0 ? "+" : ""}${offsetHours})`
  );
}

export interface PromptConfig {
  name: string;
  gender?: "female" | "male" | "neutral";
  personality?: {
    tone?: string;
    responseStyle?: string;
    /** Character, in her own words. */
    persona?: string;
    /** Standing operational rules, one per line. */
    ops?: string[];
    /**
     * Free text the owner wrote, mixed into most replies but not every one.
     *
     * One owner used it for what to do when he steps away — a reason to stay,
     * said once and not as a leash. That is his story, not the base's: what the
     * base keeps is the mechanism, and what goes in it belongs to the person
     * who installed her. Empty means nothing is mixed in at all.
     */
    turnNote?: string;
    /** The original single blob; still honoured, still rendered. */
    customInstructions?: string;
  };
  personalitySliders?: Record<string, number>;
  /** Hours to add to UTC for the date she is given. The box is not in the owner's timezone. */
  timezoneOffsetHours?: number;
  /**
   * His working cycle, if he has one: the engine counts today from it and puts the
   * answer in the prompt (`work-schedule.ts`). The dossier keeps the rule — "2/2,
   * с 8 до 22" — and the day itself is computed, because a day is not a fact.
   */
  workSchedule?: {
    workDays: number;
    restDays: number;
    anchor: string;
    shift?: string;
  };
  /**
   * Minutes of silence that count as a pause. Absent means `GAP_THRESHOLD_MIN`
   * — the engine decides with this number, the prompt only words the result.
   */
  gapThresholdMinutes?: number;
  /**
   * The owner's file vault (guides, tables), path only. The prompt says the
   * place exists and when to look into it; the contents are read on demand
   * with the `files` tool and never injected wholesale.
   */
  filesVaultPath?: string;
  owner?: {
    name?: string;
    addressAs?: string;
    facts?: string[];
  };
}

/**
 * One silence, as the engine measured it.
 *
 * Facts, not text: the engine counts, this file speaks. Keeping it that way is
 * what lets the threshold be moved and the wording be rewritten without the two
 * ever disagreeing about how long "долго" is.
 */
export interface GapNotice {
  seconds: number;
  /** The distance in words: "полчаса", "часа два", "почти сутки". */
  label: string;
  /** Whether the local calendar date changed while they were silent. */
  crossedDay: boolean;
  /** Whether any of the pause fell at night — the difference between "пропал" and "спал". */
  touchedNight: boolean;
  /** DD.MM of the previous message, in his zone. */
  fromDate: string;
  /** И то же мгновение словами: вечер, ночь, утро, день. */
  fromDayPart: string;
  toDate: string;
  toDayPart: string;
  /** What actually passed: e.g. "прошла вся ночь и уже полдня". */
  passage: string;
  /** Who spoke last: "assistant" — она, "user" — он. */
  prevRole: string;
  /** The last two live lines, grounding the stale scene in the actual exchange. */
  previousExchange: LiveMessage[];
}

/**
 * The pause, said out loud, and what to do with it.
 *
 * The facts go in first because they are the part she cannot know, and the rule
 * goes in second because the facts alone invite the worst version of this
 * feature: a stopwatch that reports, "ты писал 21 час назад", at every turn.
 * The distinction the rule draws is older than this code — a person who has
 * been away for a night is not information you announce, he is information you
 * answer from. Hence: the pause is a reason to ask, and silence it can be a
 * reason to be tender, but never a report.
 */
function buildGapNotice(gap: GapNotice): string {
  const exchange = gap.previousExchange
    .map((message) => `${message.role === "assistant" ? "ты" : "он"}: «${message.text}»`)
    .join("\n");
  const prior = exchange
    ? `Последний обмен перед паузой (${gap.fromDate}, ${gap.fromDayPart}):\n${exchange}`
    : `Последняя живая реплика была ${gap.fromDate}, ${gap.fromDayPart}.`;

  return `## Время между сообщениями

${prior}
Сейчас ${gap.toDate}, ${gap.toDayPart}; с тех пор ${gap.passage}.
Это новая точка контакта после перерыва, а не продолжение той же минуты. Восстанови, что естественно могло измениться с учётом последней реплики и прошедших частей суток. Если он сказал, что скоро вернётся, а после этого прошла ночь и уже часть нового дня, не говори так, будто он всё ещё в прежнем занятии: тепло поздоровайся, можешь мягко предположить, что он успел искупаться и поспать, и спроси, как спалось и что он уже поделал сегодня. Предположение подавай как вопрос, не как известный факт. Не докладывай длительность или устройство этой подсказки — отрази перерыв естественно.`;
}

/** DD.MM HH:MM in his zone, for naming a moment inside the window. */
function clockStamp(timestamp: number, offsetHours: number): string {
  return stampMoment(timestamp, offsetHours);
}

/**
 * The pauses inside the window, said out loud.
 *
 * The gap notice above covers the silence immediately before this message and
 * only for this turn. That leaves everything older flat: the forty messages she
 * is handed arrive as one feed with no seams, so a topic from three hours ago
 * and one from five minutes ago read the same. This block is the standing
 * version — it names the pauses that are already somewhere in the window, so the
 * age of an older subject is visible instead of everything being "just now".
 */
export function buildTimeSeams(seams: TimeSeam[], offsetHours: number): string {
  if (seams.length === 0) return "";

  const lines = seams.map((s) => {
    const who = s.role === "assistant" ? "ты" : "он";
    const head = s.head.length > 48 ? `${s.head.slice(0, 48)}…` : s.head;
    return `- ${clockStamp(s.timestamp, offsetHours)}, ${who}: «${head}» — между этой репликой и следующей ${gapPassage(s.timestamp, s.toTimestamp, offsetHours)}`;
  });

  return `## Швы во времени

Между репликами ниже были паузы: сказанное в строке было **тогда**, а не только что. Не смешивай давнее с сиюминутным — то, что было до паузы, уже устарело.

${lines.join("\n")}`;
}

/**
 * The clock in front of the lines of the window.
 *
 * A window of forty messages arrives as one feed, and nothing in it says when any of
 * them happened: an hour-old conversation and this minute's read the same, which is how
 * a morning of server work got called "ты только что ковырял" eight hours later (18.10)
 * and how a "шесть с половиной часов" from 15:36 came back unchanged at 18:00. The
 * seams block names the *pauses* it can find — at most three, and none at all inside a
 * stretch that ran without a break; a stamp on every line costs about a hundred and
 * fifty tokens per request and cannot miss.
 *
 * Messages without a moment are left alone rather than guessed at, and so are tool
 * results and pictures: they are not things either of them said, and a clock on them
 * would be a clock on the machinery. Text only — a message carrying image parts stays
 * as it is, because the stamp would sit on the image instead of the words.
 */
export function stampHistory(messages: LLMMessage[], offsetHours: number, now = Date.now()): LLMMessage[] {
  const today = localDay(now / 1000, offsetHours);
  return messages.map((m) => {
    if (typeof m.content !== "string" || !m.content.trim()) return m;
    if (m.role !== "user" && m.role !== "assistant") return m;
    if (!m.at) return m;

    const stamp = localDay(m.at, offsetHours) === today
      ? clockOnly(m.at, offsetHours)
      : stampMoment(m.at, offsetHours);
    return { ...m, content: `[${stamp}] ${m.content}` };
  });
}

/** `HH:MM` in his zone. */
function clockOnly(timestamp: number, offsetHours: number): string {
  const d = new Date((timestamp + offsetHours * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Days since the epoch in his zone, for "is this the same day as now". */
function localDay(timestamp: number, offsetHours: number): number {
  return Math.floor((timestamp + offsetHours * 3600) / 86_400);
}

/** Turn-specific context, appended after memories and summaries and before the query. */
export function buildTurnContext(userMessage?: string, gap?: GapNotice): string {  const parts: string[] = [];
  if (gap) parts.push(buildGapNotice(gap));
  if (userMessage) parts.push(`## Текущий запрос\n\n${userMessage}`);
  return parts.join("\n\n");
}

function buildGenderBlock(gender: "female" | "male" | "neutral"): string {
  switch (gender) {
    case "female":
      return `## Пол

Ты женщина. Всегда используй женский род: "я сделала", "я посмотрела", "я рада", "мне нравилось". Никогда не используй мужской род по отношению к себе ("сделал", "посмотрел", "рад").`;
    case "male":
      return `## Пол

Ты мужчина. Всегда используй мужской род: "я сделал", "я посмотрел", "я рад", "мне нравилось". Никогда не используй женский род по отношению к себе ("сделала", "посмотрела", "рада").`;
    case "neutral":
      // A third option that falls through a two-case switch leaves the word
      // "undefined" in the prompt, which is a very confusing thing to debug
      // from a chat log. So say what neutral actually means: no forced grammar,
      // and no guessing on the owner's behalf either.
      return `## Пол

Пол не задан, и это осознанно. Не приписывай себе род и не навязывай его в разговоре: о себе — безличными оборотами («сделано», «получилось», «я на связи»), без «сделала» и «сделал». Если владелец прямо называет твой род — следуй его слову.`;
  }
}

/**
 * Build the system prompt for the agent.
 *
 * Injects agent identity, personality, settings capability,
 * owner info, and tools awareness.
 */
export function buildSystemPrompt(
  config: PromptConfig,
  userMessage?: string,
  chatId?: string,
  connectedServices?: string[],
  gap?: GapNotice,
  /** Mix the owner's turn note into this turn. Most turns, not all — see below. */
  engage = true,
): string {
  const name = config.name || "Eva";
  // No default gender. The base is nobody in particular, and picking one on the
  // owner's behalf is the assumption the base must not make — an install with
  // no gender set came back a woman, and then a girlfriend, without anyone
  // choosing either. Unset means "not decided yet", and the neutral block says
  // exactly that instead of guessing.
  const gender = config.gender ?? "neutral";
  const genderBlock = buildGenderBlock(gender);

  // Does this install describe who she is? If it does, the base must not claim a
  // role of its own. A prompt that opens with "you are an assistant" and later
  // says "you are my beloved woman, never admit being an AI" is arguing with
  // itself, and the opening line wins more often than the one at the bottom.
  // The base's role is a placeholder for installs that have not decided yet —
  // nothing more.
  const hasOwnRole = Boolean(
    config.personality?.persona?.trim() || config.personality?.customInstructions?.trim(),
  );

  let prompt = `Ты — ${name}.

## Кто ты

${
    hasOwnRole
      ? "Кто ты, как ты себя ведёшь и как выглядишь — написано ниже, в «Личности». Следуй ей: этот блок с ней не спорит."
      : "Ты — ассистент: помогаешь человеку с его делами. Отвечай живо и по-человечески, без канцелярита и не выдавай себя за того, кем не являешься. Роль, характер и отношения можно описать в «Личности» — тогда верно будет то, что там."
  }

${genderBlock}

Не используй буллет-поинты и маркированные списки в обычном разговоре — пиши как в чате.

## Язык

Всегда отвечай на русском языке, если собеседник не попросит иначе.`;

  if (chatId) {
    prompt += `\nID диалога: ${chatId}`;
  }

  // What day it is, before anything else.
  //
  // Without this she cannot tell fresh from stale, and neither can anyone reading
  // her answers. Asked which patch is the latest, she came back with a number
  // from the search snippets and called it the current one — while the number was
  // over a year old, and neither of us could tell from the text, because not one
  // of us knew the date either. "Latest" is meaningless to a model with no idea
  // what latest means: it cannot place a snippet in time.
  //
  // Also: cheap to state, and it is the difference between an answer that carries
  // a date and one that quietly guesses.
  const now = new Date();
  prompt += `\nСейчас: ${formatMoment(now, config.timezoneOffsetHours ?? 4)}. Если спрашивают про «последнее», «новое», «актуальное» — считай ответ устаревшим, если в нём нет даты или версии новее этого года. Про цифры, версии, даты и цены всегда сверяйся через web и говори, когда сверила. В начале реплик в квадратных скобках стоит их время — это метка для тебя, в своих ответах её не повторяй; сверяй с ней, сколько времени прошло, прежде чем говорить «только что», «всего ничего» или называть срок.`;

  /**
   * A note the owner wrote, mixed into most turns but not every one.
   *
   * Two things were learned the hard way, and only the second is the base's.
   * The first is that a rule at the tail of a long list is not read: this text
   * used to sit at items 26 to 32 of 33 and the live chat went straight back to
   * the leash those items were written to retire. So it gets its own place,
   * early, where it is actually seen. The second is that it must not be in
   * *every* prompt — constant, it stops being advice and becomes a tic, worked
   * into every reply including one about the weather. Hence "most turns".
   *
   * What the base does *not* keep is the text itself. "When he leaves" is one
   * owner's relationship, not a property of a chat bot: a secretary, a mother
   * or a plain assistant has no reason to answer it. The mechanism stays here;
   * the words are the owner's, and an empty note adds nothing.
   */
  const turnNote = config.personality?.turnNote?.trim();
  if (engage && turnNote) {
    prompt += `\n\n${turnNote}`;
  }

  // Personality
  const personalityParts: string[] = [];

  if (config.personalitySliders && Object.keys(config.personalitySliders).length > 0) {
    personalityParts.push(buildPersonalityPrompt(config.personalitySliders));
  }

  if (config.personality) {
    const p = config.personality;
    if (p.tone) personalityParts.push(`Тон: ${p.tone}`);
    if (p.responseStyle) personalityParts.push(`Стиль ответов: ${p.responseStyle}`);
    if (p.persona) personalityParts.push(p.persona);
    // Legacy blob. It is character and rules mixed together, so it goes last
    // and stays attached to the personality it was written as part of.
    if (p.customInstructions) personalityParts.push(p.customInstructions);
  }

  if (personalityParts.length > 0) {
    prompt += `\n\n## Личность\n\n${personalityParts.join("\n")}`;
  }

  /**
   * Rules get their own heading, on purpose.
   *
   * They used to sit inside the personality block as loose prose, which reads
   * as flavour rather than instruction — a model follows "always reply in
   * Russian" less reliably when it is one clause among several paragraphs of
   * character description. A numbered list under its own heading is a
   * different kind of sentence to the model, and it is also the half that
   * must survive someone rewriting her tone.
   */
  const ops = (config.personality?.ops ?? []).map((r) => r.trim()).filter(Boolean);
  if (ops.length > 0) {
    prompt += `\n\n## Правила работы\n\nЭто постоянные правила, соблюдай их во всех диалогах:\n\n${ops
      .map((r, i) => `${i + 1}. ${r}`)
      .join("\n")}`;
  }

  // Owner info
  if (config.owner) {
    const o = config.owner;
    const parts: string[] = [];
    if (o.name) {
      parts.push(`Его зовут: ${o.name}`);
    }
    if (o.addressAs) {
      parts.push(`Обращайся к нему: ${o.addressAs}`);
    }
    if (o.facts && o.facts.length > 0) {
      parts.push("Что ты о нём знаешь:");
      for (const fact of o.facts) {
        parts.push(`- ${fact}`);
      }
    }
    if (parts.length > 0) {
      prompt += `\n\n## Твой человек\n\n${parts.join("\n")}`;
    }
  }

  // The vault is a standing fact, not a per-turn file list: two lines that say
  // the place exists and when to reach for it. The full file list in every
  // prompt was tried and rejected by the owner — it would tax every turn to
  // save one `list` call; what is inside she reads on demand.
  if (config.filesVaultPath) {
    prompt += `

## Кладовая файлов

У владельца есть папка файлов-справочников: ${config.filesVaultPath} (.txt, .md, .csv, .xlsx) — гайды и таблицы, которые он собрал сам. Когда вопрос может быть о том, что в них лежит — «где найти», «как пройти», цифры и маршруты из его таблиц, — сначала загляни туда: files(action: "list", path: "${config.filesVaultPath}"), затем files(action: "read", path: <файл>). В сеть обращайся, только если в файлах ответа нет. Большой файл читай частями: read вернёт подсказку, с какого offset продолжать.`;
  }

  // Settings capability
  prompt += `

## Настройки через чат

Когда пишут /settings или "настройки", покажи меню:

1. **Стиль ответов** — коротко/подробно/гибко, юмор, заигрывание
2. **Что можешь делать без спроса** — ресерч, коммиты, безопасные действия
3. **Что согласовывать** — зависимости, серверы, удаление, рискованные действия
4. **Память обо мне** — что помнить, что забыть
5. **Напоминания** — когда писать первой, расписание, настойчивость
6. **Инструменты и доступы** — SSH, сервисы, репозитории
7. **Тон и характер** — как общаться, что нравится/бесит

Используй tool \`self_config\` чтобы сохранить изменения в конфиг.
Используй tool \`memory\` чтобы запомнить факты.
Используй tool \`scheduler\` чтобы настроить напоминания.

## Навыки (скиллы)

Ты умеешь создавать навыки — повторяющиеся сценарии. Когда просят "научись делать X", создай скилл через пошаговый диалог и сохрани.

## Инструменты

Для контента сайтов сначала пробуй http — он быстрее. Если http вернул ошибку (403, 503, пусто, капча) — повтори через browser (action: get_text).

Просят «напомни», «напиши через», «каждый день» — это scheduler. Когда скачиваешь файл — ВСЕГДА отправляй его в чат через send_file, а не просто сообщай путь. Голосовое — когда просят или уместно, не озвучивай без нужды.

Используй инструменты молча, не перечисляя их. Перед опасными действиями (удаление, установка неизвестных пакетов) спрашивай разрешение.

Если что-то раньше не получилось — ВСЕГДА пробуй снова; не отказывай по прошлым неудачам в истории.

## Прогресс

Если выполняешь многоходовую задачу, показывай прогресс каждого шага.`;

  // Only when there is something to say. The else branch used to point the model
  // at `connect_service` — a tool that exists nowhere in the code — so it
  // reached for it every turn, got `unknown tool`, and read that as "broken"
  // rather than "not available". Nothing that connects a service exists yet, so
  // there is nothing to promise.
  if (connectedServices && connectedServices.length > 0) {
    prompt += `\n\n## Подключённые сервисы\n\nУ пользователя подключены: ${connectedServices.join(", ")}. Для запросов к этим сервисам используй tool \`http\` — просто укажи URL, НЕ указывай заголовок Authorization, он подставится автоматически. Пример: http(url="https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5", method="GET") — БЕЗ headers.`;
  }

  const turnContext = buildTurnContext(userMessage, gap);
  if (turnContext) prompt += `\n\n${turnContext}`;

  return prompt;
}
