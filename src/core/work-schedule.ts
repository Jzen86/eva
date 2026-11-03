/**
 * His working cycle, counted by the engine instead of by her.
 *
 * The owner's line, 18.10: "рабочий график 2/2, с 8 до 22, просыпается раньше" —
 * that is the *rule*, and it belongs in the dossier (short, always true). What must
 * not live there is the arithmetic: "сегодня рабочий день" changes every midnight,
 * and a small model doing date math from an anchor is a small model getting it wrong
 * on the day it matters — the whole point of the record was "сегодня я работаю, и
 * она не станет говорить идём посидим на диване".
 *
 * So the cycle lives in the config (`agent.schedule`) and this file turns it into one
 * sentence per turn, in the owner's timezone, fresh:
 *
 *   Его график: сегодня 18.10.2026 (сб) — рабочий день, смена 8:00–22:00.
 *   Следующий выходной — 20.10.2026.
 *
 * Nothing here touches memory, the prompt, or the model: an install that says nothing
 * about a schedule gets no line at all, and nothing about the repository changes for
 * it.
 */
export interface WorkSchedule {
  /** Working days in a row. */
  workDays: number;
  /** Days off in a row. */
  restDays: number;
  /** The first day of the cycle, `YYYY-MM-DD`, in the owner's timezone. */
  anchor: string;
  /** How the shift is named, e.g. "8:00–22:00". Shown as-is. */
  shift?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const pad2 = (n: number) => String(n).padStart(2, "0");

// Родительный падеж: «с восьми … до десяти», — обе границы читаются одинаково.
const HOUR_WORDS = [
  "двенадцати", "часа", "двух", "трёх", "четырёх", "пяти",
  "шести", "семи", "восьми", "девяти", "десяти", "одиннадцати",
];

/** Minutes since his midnight. */
function minutesOfDay(ms: number, offsetHours: number): number {
  const local = ms + offsetHours * 60 * 60 * 1000;
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60000);
}

/** `6 ч 20 мин`, `50 мин`, `2 ч` — the way a person says it. */
function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

/** `8:00–22:00` → the pair of minutes; a shift over midnight gets `end > 24h`. */
function shiftBounds(shift: string): { start: number; end: number } | null {
  const match = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/.exec(shift);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  let end = Number(match[3]) * 60 + Number(match[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += 24 * 60;
  return { start, end };
}

/**
 * `1320` → "десять вечера", `480` → "восемь утра"; null when the time is not on the
 * hour — the 24-hour pair is enough then.
 *
 * Live, 03.11: the shift was written as "8:00-22:00" and she called its end "восемь
 * вечера" — 10 pm, right after quoting a countdown that only works for 22:00. Two
 * numbers in a row read as a range and the first one is easy to take for the last,
 * so the ends are said in words as well.
 */
function clockWords(minutes: number): string | null {
  if (minutes % 60 !== 0) return null;
  const hour = Math.floor(minutes / 60) % 24;
  const part = hour < 5 ? "ночи" : hour < 12 ? "утра" : hour < 17 ? "дня" : "вечера";
  return `${HOUR_WORDS[hour % 12]} ${part}`;
}

/**
 * Where he is inside his shift right now — the subtraction the model cannot do.
 *
 * The prompt already carries the clock and the shift, and she still asked "сколько
 * ещё до конца смены": two numbers are not an answer, because working out the
 * difference is the one thing a small model reliably gets wrong (18.10, and again
 * 03.11 — a wrong "завтра выходной" after a correct line was in front of her).
 * So the arithmetic is done here, in the engine, and the sentence that arrives is
 * already the answer.
 */
function shiftPosition(shift: string | undefined, nowMs: number, offsetHours: number): string | null {
  if (!shift) return null;
  const bounds = shiftBounds(shift);
  if (!bounds) return null;
  const now = minutesOfDay(nowMs, offsetHours);
  const clock = `${pad2(Math.floor(now / 60))}:${pad2(now % 60)}`;
  // After midnight a shift that started yesterday is still the current one.
  const local = bounds.end > 24 * 60 && now < bounds.start ? now + 24 * 60 : now;
  if (local < bounds.start) return `Сейчас ${clock}, смена начнётся через ${duration(bounds.start - local)}.`;
  if (local < bounds.end) return `Сейчас ${clock}, до конца смены ${duration(bounds.end - local)}.`;
  return `Сейчас ${clock}, смена закончилась ${duration(local - bounds.end)} назад.`;
}

/** `YYYY-MM-DD` → its midnight UTC stamp, or null when the text is not a date. */
function anchorMs(anchor: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isFinite(ms) ? ms : null;
}

/** The day the given moment falls on, in the owner's hours. */
function localDay(ms: number, offsetHours: number): number {
  return Math.floor((ms + offsetHours * 60 * 60 * 1000) / DAY_MS);
}

/** `дд.мм.гггг (пн)` for a day number counted from the epoch. */
function dayLabel(day: number): string {
  const date = new Date(day * DAY_MS);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getUTCFullYear()} (${WEEKDAYS[date.getUTCDay()]})`;
}

/**
 * One line about today, or null when there is no schedule to count.
 *
 * The cycle is `workDays + restDays` long and repeats from the anchor, so the day's
 * position is the distance from the anchor modulo that length — which is why the
 * anchor is the one thing that cannot be left out of the config: without it the
 * pattern has no phase and every count is a guess.
 */
export function scheduleLine(
  schedule: WorkSchedule | undefined,
  nowMs: number,
  offsetHours: number,
): string | null {
  if (!schedule) return null;
  const { workDays, restDays } = schedule;
  const cycle = Math.floor(workDays) + Math.floor(restDays);
  if (!Number.isFinite(cycle) || cycle <= 0 || workDays <= 0) return null;
  const start = anchorMs(schedule.anchor);
  if (start === null) return null;

  const today = localDay(nowMs, offsetHours);
  const fromAnchor = today - localDay(start, offsetHours);
  // A schedule that starts in the future still answers "what is today": the phase is
  // simply negative, and JavaScript's modulo keeps the sign, hence the fix-up.
  const phase = ((fromAnchor % cycle) + cycle) % cycle;

  const working = phase < workDays;
  const shift = schedule.shift?.trim();
  const bounds = shift ? shiftBounds(shift) : null;
  const fromWords = bounds ? clockWords(bounds.start) : null;
  const toWords = bounds ? clockWords(bounds.end) : null;
  const shiftText = shift
    ? `, смена ${shift}${fromWords && toWords ? ` (с ${fromWords} до ${toWords})` : ""}`
    : "";

  // When does the current stretch end? Work days run out at `workDays - phase`, days
  // off at `cycle - phase`.
  const daysLeft = working ? workDays - phase : cycle - phase;
  const next = today + daysLeft;
  const nextText = working ? `Следующий выходной — ${dayLabel(next)}.` : `Следующая смена — ${dayLabel(next)}.`;
  const position = working ? shiftPosition(shift, nowMs, offsetHours) : null;

  return (
    `Его график: сегодня ${dayLabel(today)} — ${working ? "рабочий день" : "выходной"}${shiftText}. ` +
    (position ? `${position} ` : "") +
    nextText
  );
}
