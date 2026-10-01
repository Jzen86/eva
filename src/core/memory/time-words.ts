import { counted } from "./stem-ru.js";

/**
 * How time is spoken about, in one place.
 *
 * Two things need this vocabulary and they must not grow two voices: the memory
 * of facts ("неделю назад мы говорили про самолёты") and the distance between
 * two messages ("прошло 21 час"). The first one already existed and lived in
 * `knowledge.ts`; the second did not exist at all, which is why a week of
 * silence read to her as a continuation of the same sentence. A gap and an age
 * are the same kind of quantity, so they are worded here and nowhere else.
 *
 * Words rather than a clock, for the reason the knowledge base learned first: a
 * model asked to subtract 26.09 from 05.10 sometimes gets it wrong, and it
 * cannot tell "пять дней" from "два месяца" by feel. It can read a phrase.
 */

/**
 * Silence shorter than this is not a pause.
 *
 * Ten minutes is not nothing to a person — "милый, ты где был?" is a real thing
 * to say — but that is tenderness, not measurement: she says it because she
 * wants to, and she has always been able to. What she cannot do without help is
 * notice that the state has gone stale, and ten minutes never stales anything.
 * So the line is drawn where the facts change, and kept tunable in the config
 * (`agent.gap_threshold_min`) because the right value is a matter of taste.
 */
export const GAP_THRESHOLD_MIN = 30;

/** DD.MM in the owner's zone, so it agrees with the "Сейчас:" line in the prompt. */
export function shortDate(timestamp: number, offsetHours: number): string {
  const d = new Date((timestamp + offsetHours * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`;
}

/**
 * Ночь, утро, день, вечер — the part of the day a given moment fell into.
 *
 * "Спал" is a conclusion drawn from the shape of an interval, not from its
 * length: two hours at noon and two hours at 3 a.m. are the same number and
 * different news. A clock hands the model `17:42` and asks it to know that this
 * is вечер; the mapping is four lines long, so it is done here instead.
 */
export function dayPart(timestamp: number, offsetHours: number): "ночь" | "утро" | "день" | "вечер" {
  const hour = new Date((timestamp + offsetHours * 3600) * 1000).getUTCHours();
  if (hour >= 23 || hour < 6) return "ночь";
  if (hour < 12) return "утро";
  if (hour < 18) return "день";
  return "вечер";
}

/**
 * How long ago, in the words a person would use.
 *
 * Words and not a date, because the answer is spoken: "неделю назад мы про это
 * говорили" is the sentence this exists to make possible, and a model asked to
 * subtract 26.09 from 05.10 to get there will sometimes get it wrong. The date
 * is printed beside it for the times he asks which day.
 */
/**
 * `DD.MM HH:MM` in his zone — a moment, not just a day.
 *
 * A day is not a distance. Two stretches on the same date both print as one
 * date, so "he was in the game" at 02:36 and "he was in the code" at 04:38 look
 * the same age, and she merged them into one continuous present. The clock is
 * what separates them.
 */
export function stampMoment(timestamp: number, offsetHours: number): string {
  const d = new Date((timestamp + offsetHours * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function relativeAge(timestamp: number, now = Math.floor(Date.now() / 1000)): string {
  const days = Math.floor((now - timestamp) / 86_400);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 7) return `${counted(days, "день", "дня", "дней")} назад`;
  if (days < 14) return "неделю назад";
  if (days < 28) return `${counted(Math.round(days / 7), "неделю", "недели", "недель")} назад`;
  return `${counted(Math.round(days / 30), "месяц", "месяца", "месяцев")} назад`;
}

/**
 * A silence, as a distance.
 *
 * Rounded on purpose, and coarsely. "2 часа 14 минут" is a reading off an
 * instrument; "часа два" is what a person says. The whole point of handing her a
 * duration is that she should feel its size, and a precise number makes the size
 * smaller, not bigger — the ear hears the digits as a stopwatch.
 */
export function humanGap(seconds: number): string {
  const minutes = seconds / 60;

  if (minutes < 1.5) return "минуту";
  if (minutes < 25) {
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    return counted(rounded, "минута", "минуты", "минут");
  }
  if (minutes < 45) return "полчаса";
  if (minutes < 100) return "час";
  if (minutes < 150) return "около двух часов";
  if (minutes < 210) return "часа три";
  if (minutes < 270) return "часа четыре";
  if (minutes < 330) return "часов пять";
  if (minutes < 420) return "часов шесть";
  if (minutes < 540) return "часов восемь";
  if (minutes < 660) return "часов десять";

  const hours = minutes / 60;
  if (hours < 20) return "полдня";
  if (hours < 26) return "почти сутки";
  if (hours < 40) return "сутки";
  if (hours < 64) return "двое суток";
  if (hours < 88) return "трое суток";

  const days = Math.round(hours / 24);
  if (days < 7) return counted(days, "день", "дня", "дней");

  const weeks = Math.round(days / 7);
  if (weeks === 1) return "неделю";
  if (weeks < 6) return counted(weeks, "неделя", "недели", "недель");

  const months = Math.round(days / 30);
  if (months <= 1) return "месяц";
  return counted(months, "месяц", "месяца", "месяцев");
}

/**
 * The facts of one silence, for whoever is going to phrase it.
 *
 * Numbers and flags only — no sentences. Wording belongs to the prompt, which
 * is also where the rule about what to do with a pause lives, and separating
 * the two is what lets the threshold be tuned without touching the voice.
 */
export interface GapFacts {
  seconds: number;
  /** The distance in words: "полчаса", "часа два", "почти сутки". */
  label: string;
  /** Whether the local calendar date changed while they were silent. */
  crossedDay: boolean;
  /** Whether any of the pause fell into the night — the difference between "пропал" and "спал". */
  touchedNight: boolean;
  /** When the previous message was: DD.MM in his zone. */
  fromDate: string;
  /** И то же мгновение словами: вечер, ночь, утро, день. */
  fromDayPart: string;
}

/** How far apart two moments are, in the terms the prompt can use. */
export function gapFacts(fromTs: number, toTs: number, offsetHours: number): GapFacts {
  const seconds = Math.max(0, toTs - fromTs);

  return {
    seconds,
    label: humanGap(seconds),
    crossedDay: localDay(fromTs, offsetHours) !== localDay(toTs, offsetHours),
    touchedNight: touchesNight(fromTs, toTs, offsetHours),
    fromDate: shortDate(fromTs, offsetHours),
    fromDayPart: dayPart(fromTs, offsetHours),
  };
}

/** Days since the epoch in his zone — a date he would recognise, not UTC's. */
function localDay(timestamp: number, offsetHours: number): number {
  return Math.floor((timestamp + offsetHours * 3600) / 86_400);
}

/**
 * Whether the pause contained any night hours.
 *
 * Stepped rather than solved, because the night is not an interval on a
 * timeline but a label on a clock face, and `dayPart` already knows where the
 * line is. A pause of a full day or more contains a night by definition, so the
 * walk is only ever paid for the short gaps — which are the common ones anyway.
 */
function touchesNight(fromTs: number, toTs: number, offsetHours: number): boolean {
  if (toTs - fromTs >= 86_400) return true;
  for (let t = fromTs; t <= toTs; t += 900) {
    if (dayPart(t, offsetHours) === "ночь") return true;
  }
  return false;
}
