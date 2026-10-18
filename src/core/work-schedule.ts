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
  const shiftText = shift ? `, смена ${shift}` : "";

  // When does the current stretch end? Work days run out at `workDays - phase`, days
  // off at `cycle - phase`.
  const daysLeft = working ? workDays - phase : cycle - phase;
  const next = today + daysLeft;
  const nextText = working ? `Следующий выходной — ${dayLabel(next)}.` : `Следующая смена — ${dayLabel(next)}.`;

  return (
    `Его график: сегодня ${dayLabel(today)} — ${working ? "рабочий день" : "выходной"}${shiftText}. ` +
    nextText
  );
}
