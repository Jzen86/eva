import { describe, it, expect } from "vitest";
import { scheduleLine, type WorkSchedule } from "../../src/core/work-schedule.js";

/**
 * His cycle, counted by the engine.
 *
 * The owner, 18.10: "рабочий график 2/2, с 8 до 22, просыпается раньше" — the rule
 * lives in the dossier, and *today* is the part that changes at midnight. He also
 * said what the arithmetic is for: "сегодня я работаю, и она не станет говорить
 * идём посидим на диване, это невозможно".
 *
 * The dates below are the real ones from that conversation: 18.10.2026 is the anchor
 * and the first working day, so 18–19 are shifts and 20–21 are days off.
 */
const CYCLE: WorkSchedule = { workDays: 2, restDays: 2, anchor: "2026-10-18", shift: "8:00–22:00" };

/** Midnight UTC of a `YYYY-MM-DD`, which is how the anchor is read; offset 4 like the box. */
function at(date: string, hourUtc = 6): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hourUtc);
}

describe("scheduleLine", () => {
  it("says nothing at all when no cycle is configured", () => {
    // The repository is a base, not an instance: an install that never heard of a
    // schedule must not grow a line about one.
    expect(scheduleLine(undefined, at("2026-10-18"), 4)).toBeNull();
  });

  it("says nothing when the anchor is not a date", () => {
    expect(scheduleLine({ ...CYCLE, anchor: "18.10.2026" }, at("2026-10-18"), 4)).toBeNull();
  });

  it("counts the working days from the anchor", () => {
    const day1 = scheduleLine(CYCLE, at("2026-10-18", 2), 4);
    expect(day1).toContain("18.10.2026 (вс) — рабочий день, смена 8:00–22:00");
    expect(day1).toContain("Следующий выходной — 20.10.2026");

    // Second working day: still a shift, still the same answer about the next day off.
    expect(scheduleLine(CYCLE, at("2026-10-19", 2), 4)).toContain("19.10.2026 (пн) — рабочий день");
  });

  it("counts the days off, and names the next shift", () => {
    const off = scheduleLine(CYCLE, at("2026-10-20", 2), 4);
    expect(off).toContain("20.10.2026 (вт) — выходной");
    expect(off).toContain("Следующая смена — 22.10.2026");

    // Second day off: the cycle restarts the day after.
    const off2 = scheduleLine(CYCLE, at("2026-10-21", 2), 4);
    expect(off2).toContain("21.10.2026 (ср) — выходной");
    expect(scheduleLine(CYCLE, at("2026-10-22", 2), 4)).toContain("22.10.2026 (чт) — рабочий день");
  });

  it("keeps the cycle repeating after the first one", () => {
    // 18.10 + 4 = 22.10 is the first day of the next cycle, and the pattern has to
    // hold far past the anchor — this is read every day for months.
    expect(scheduleLine(CYCLE, at("2026-11-15", 2), 4)).toContain("рабочий день");
    expect(scheduleLine(CYCLE, at("2026-11-17", 2), 4)).toContain("выходной");
  });

  it("counts in the owner's hours, not the box's", () => {
    // 21.10 22:00 UTC is already 22.10 02:00 for him (+4), and the shift day changed
    // at his midnight: the same instant is a different day on the box.
    const hisDay = scheduleLine(CYCLE, Date.UTC(2026, 9, 21, 22), 4);
    const boxDay = scheduleLine(CYCLE, Date.UTC(2026, 9, 21, 22), 0);
    expect(hisDay).toContain("22.10.2026 (чт) — рабочий день");
    expect(boxDay).toContain("21.10.2026 (ср) — выходной");
  });

  it("answers for a schedule that has not started yet", () => {
    // Setting the anchor tomorrow is a normal thing to do while writing the config,
    // and the phase before it is negative — the answer must still be a day, not NaN.
    const before = scheduleLine({ ...CYCLE, anchor: "2026-10-20" }, at("2026-10-18", 2), 4);
    expect(before).toContain("18.10.2026");
    expect(before).not.toContain("NaN");
  });

  it("leaves the shift out when none is named", () => {
    const line = scheduleLine({ workDays: 2, restDays: 2, anchor: "2026-10-18" }, at("2026-10-18", 2), 4);
    expect(line).toContain("рабочий день.");
    expect(line).not.toContain("смена");
  });
});
