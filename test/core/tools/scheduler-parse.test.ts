import { describe, it, expect } from "vitest";
import { parseAtTime, parseEveryDuration, parseTimesOfDay } from "../../../src/core/tools/scheduler-parse.js";

describe("parseAtTime", () => {
  // The owner is four hours ahead of the box, as the live install has it.
  const HIS = 4;

  it("parses relative +5m", () => {
    const now = Date.now();
    const result = parseAtTime("+5m", now, HIS);
    expect(result).toBeGreaterThanOrEqual(now + 5 * 60_000 - 100);
    expect(result).toBeLessThanOrEqual(now + 5 * 60_000 + 100);
  });

  it("parses relative +2h30m", () => {
    const now = Date.now();
    const result = parseAtTime("+2h30m", now, HIS);
    const expected = now + 2 * 3600_000 + 30 * 60_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("parses relative +1d", () => {
    const now = Date.now();
    const result = parseAtTime("+1d", now, HIS);
    expect(Math.abs(result - (now + 86_400_000))).toBeLessThan(100);
  });

  it("reads a bare ISO datetime on the owner's clock", () => {
    // "2026-03-18T15:30" is how *he* writes half past three. The box runs on UTC,
    // so reading it there put the reminder four hours off and named a time he had
    // not asked for.
    const result = parseAtTime("2026-03-18T15:30:00", Date.now(), HIS);
    expect(result).toBe(new Date("2026-03-18T15:30:00+04:00").getTime());
    expect(new Date(result).getUTCHours()).toBe(11);
    // And the zone comes from the argument, not from the machine running the test:
    // two offsets must give two instants five hours apart. (This box is on UTC+4,
    // where the old code happened to land on the right answer.)
    expect(parseAtTime("2026-03-18T15:30:00", Date.now(), 9) - result).toBe(-5 * 3_600_000);
  });

  it("leaves a datetime that names its own zone alone", () => {
    expect(parseAtTime("2026-03-18T15:30:00Z", Date.now(), HIS))
      .toBe(new Date("2026-03-18T15:30:00Z").getTime());
    expect(parseAtTime("2026-03-18T15:30:00+03:00", Date.now(), HIS))
      .toBe(new Date("2026-03-18T15:30:00+03:00").getTime());
  });

  it("takes a bare date as midnight on his clock", () => {
    // ISO reads "2026-03-18" as midnight UTC, which is the evening of the
    // seventeenth for him — a reminder set for "the eighteenth" arriving a day early.
    const result = parseAtTime("2026-03-18", Date.now(), HIS);
    expect(result).toBe(new Date("2026-03-18T00:00:00+04:00").getTime());
    expect(parseAtTime("2026-03-18", Date.now(), 0) - result).toBe(4 * 3_600_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseAtTime("garbage", Date.now(), HIS)).toThrow();
  });
});

describe("parseTimesOfDay", () => {
  it("reads a list of times into sorted minutes", () => {
    // The owner asked for "9:15, 15:00, 21:15, 3:00" for the server check: two of them
    // fifteen minutes after his own check, two on the hour. One cron line cannot say
    // that — it multiplies hours by minutes and would fire eight times a day.
    expect(parseTimesOfDay("09:15, 15:00, 21:15, 03:00")).toEqual([180, 555, 900, 1275]);
    expect(parseTimesOfDay("9:15 15:00")).toEqual([555, 900]);
    expect(parseTimesOfDay("06:00, 06:00")).toEqual([360]);
  });

  it("refuses what is not a time", () => {
    expect(() => parseTimesOfDay("9 утра")).toThrow(/HH:MM/);
    expect(() => parseTimesOfDay("25:00")).toThrow(/HH:MM/);
    expect(() => parseTimesOfDay("  ")).toThrow();
  });
});

describe("parseEveryDuration", () => {
  it("parses 30s", () => {
    expect(parseEveryDuration("30s")).toBe(30_000);
  });

  it("parses 5m", () => {
    expect(parseEveryDuration("5m")).toBe(300_000);
  });

  it("parses 2h", () => {
    expect(parseEveryDuration("2h")).toBe(7_200_000);
  });

  it("parses 1d", () => {
    expect(parseEveryDuration("1d")).toBe(86_400_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseEveryDuration("abc")).toThrow();
  });
});
