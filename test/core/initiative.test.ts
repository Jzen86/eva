import { describe, it, expect } from "vitest";
import {
  minutesOfDay,
  parseInitiative,
  instanceAt,
  targetOffsets,
  localClock,
  dueNow,
  markSent,
  type InitiativeState,
} from "../../src/core/initiative.js";

const NONE: InitiativeState = { instanceId: "", fired: 0, lastSentAt: 0 };
/** A UTC timestamp whose local (offset 0) time is exactly h:mm on 11 Oct 2026. */
const at = (h: number, m: number, day = 11): number => Date.UTC(2026, 9, day, h, m, 0);

const onePeriod = () =>
  parseInitiative({
    enabled: true,
    periods: [{ name: "утро", from: "06:00", to: "10:00", per_day: 1 }],
  })!;

describe("initiative", () => {
  it("reads times and drops a period it cannot use", () => {
    expect(minutesOfDay("06:00")).toBe(360);
    expect(minutesOfDay("23:59")).toBe(1439);
    expect(minutesOfDay("6:00")).toBe(360);
    expect(minutesOfDay("24:00")).toBe(1440);
    expect(minutesOfDay("24:30")).toBeNull();
    expect(minutesOfDay("nonsense")).toBeNull();

    const cfg = parseInitiative({
      enabled: true,
      periods: [
        { name: "ок", from: "06:00", to: "10:00", per_day: 2 },
        { name: "битый", from: "ой", to: "10:00" },
        { name: "пустой интервал", from: "10:00", to: "10:00" },
      ],
    })!;
    expect(cfg.periods.map((p) => p.name)).toEqual(["ок"]);
    expect(cfg.periods[0].perDay).toBe(2);
  });

  it("is off until it is switched on", () => {
    const off = parseInitiative({ periods: [{ name: "утро", from: "06:00", to: "10:00" }] })!;
    expect(off.enabled).toBe(false);
    expect(dueNow(off, NONE, at(7, 0), 0, null)).toBeNull();
  });

  it("fires only after the day's moment for that period has arrived", () => {
    const cfg = onePeriod();
    const period = cfg.periods[0];
    const id = "2026-10-11#утро";
    // Pinned on purpose: the seed is the date, so this is a fixed number, and the
    // conditional that stood here (`if (target > 0)`) meant that on the day the seed
    // picked 0 the check quietly stopped checking anything.
    const target = targetOffsets(period, id)[0];
    expect(target).toBe(180);

    // Before the moment — nothing.
    expect(dueNow(cfg, NONE, at(6, target - 1), 0, null)).toBeNull();
    // At the moment — due.
    const due = dueNow(cfg, NONE, at(6, target), 0, null);
    expect(due?.instance.id).toBe(id);
  });

  it("keeps the same moments all day — the randomness is per day, not per tick", () => {
    const period = onePeriod().periods[0];
    expect(targetOffsets(period, "2026-10-11#утро")).toEqual(targetOffsets(period, "2026-10-11#утро"));
    const a = targetOffsets(period, "2026-10-11#утро")[0];
    const b = targetOffsets(period, "2026-10-12#утро")[0];
    // Both values are fixed by the date seed (mulberry32 over "date#period"), which is
    // the promise this test exists for: one day, one set — the same tick after tick.
    // `expect(typeof b).toBe("number")` stood here and asserted nothing: it passed for
    // any value, including a broken generator.
    expect(a).toBe(180);
    expect(b).toBe(223);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(240);
  });

  it("does not exceed the per-period cap, and does not talk over the owner", () => {
    const cfg = onePeriod();
    const target = targetOffsets(cfg.periods[0], "2026-10-11#утро")[0];
    const after = at(6, Math.min(target + 1, 239));

    const sent: InitiativeState = markSent(NONE, "2026-10-11#утро", after);
    expect(dueNow(cfg, sent, after, 0, null)).toBeNull();

    // He wrote two minutes ago — silence.
    expect(dueNow(cfg, NONE, after, 0, after - 2 * 60_000)).toBeNull();
  });

  it("respects the minimum gap between two sends", () => {
    const cfg = parseInitiative({
      enabled: true,
      min_gap_min: 90,
      periods: [{ name: "вечер", from: "18:00", to: "22:00", per_day: 2 }],
    })!;
    const id = "2026-10-11#вечер";
    const targets = targetOffsets(cfg.periods[0], id);
    const second = targets.length > 1 ? targets[1] : targets[0];
    const when = at(18, second);
    const state: InitiativeState = { instanceId: id, fired: 1, lastSentAt: when - 10 * 60_000 };
    expect(dueNow(cfg, state, when, 0, null)).toBeNull();
  });

  it("treats a night that wraps midnight as one occurrence", () => {
    const cfg = parseInitiative({
      enabled: true,
      periods: [{ name: "ночь", from: "22:00", to: "06:00", per_day: 1 }],
    })!;

    const late = instanceAt(cfg, "2026-10-11", 23 * 60)!;
    expect(late.id).toBe("2026-10-11#ночь");
    const early = instanceAt(cfg, "2026-10-12", 60)!;
    // 01:00 belongs to the evening it started: same occurrence, so the cap holds.
    expect(early.id).toBe("2026-10-11#ночь");
    expect(early.elapsed).toBe(180);

    const sent: InitiativeState = { instanceId: "2026-10-11#ночь", fired: 1, lastSentAt: at(23, 0) };
    const target = targetOffsets(cfg.periods[0], "2026-10-11#ночь")[0];
    const afterSecond = at(1, Math.min(target + 1, 359), 12);
    expect(dueNow(cfg, sent, afterSecond, 0, null)).toBeNull();
  });

  it("uses the owner's local clock, not the server's", () => {
    // 06:37 UTC is 10:37 for an owner at +4 — a morning period there is not one here.
    const cfg = parseInitiative({
      enabled: true,
      periods: [{ name: "утро", from: "06:00", to: "09:00", per_day: 1 }],
    })!;
    expect(localClock(at(6, 37), 4).minutes).toBe(6 * 60 + 37 + 240);
    // At 05:00 UTC with +4 it is 09:00 local: outside the window.
    expect(dueNow(cfg, NONE, at(5, 0), 4, null)).toBeNull();
  });

  it("takes the owner's own table, 24:00 and all", () => {
    const cfg = parseInitiative({
      enabled: true,
      periods: [
        { name: "утро", from: "06:00", to: "10:00", per_day: 1 },
        { name: "день", from: "10:00", to: "20:00", per_day: 1 },
        { name: "вечер", from: "20:00", to: "24:00", per_day: 1 },
        { name: "ночь", from: "00:00", to: "06:00", per_day: 1 },
      ],
    })!;
    expect(cfg.periods.map((p) => p.name)).toEqual(["утро", "день", "вечер", "ночь"]);
    // 23:30 is the evening, not the night; 01:00 is the night.
    expect(instanceAt(cfg, "2026-10-11", 23 * 60 + 30)!.period.name).toBe("вечер");
    expect(instanceAt(cfg, "2026-10-12", 60)!.period.name).toBe("ночь");
    // 09:00 is morning.
    expect(instanceAt(cfg, "2026-10-11", 9 * 60)!.period.name).toBe("утро");
  });

  it("fires on a whole-day period instead of skipping it in silence", () => {
    // "пиши весь день". The wrap-aware length of 00:00–24:00 is 0, and every check
    // downstream reads a zero length as "not a period": the config was accepted,
    // the doctor printed it, and it never fired once.
    const cfg = parseInitiative({
      enabled: true,
      periods: [{ name: "весь день", from: "00:00", to: "24:00", per_day: 2 }],
    })!;
    expect(cfg.periods).toHaveLength(1);
    expect(instanceAt(cfg, "2026-10-11", 0)!.period.name).toBe("весь день");
    expect(instanceAt(cfg, "2026-10-11", 23 * 60 + 59)!.period.name).toBe("весь день");
    expect(targetOffsets(cfg.periods[0], "2026-10-11#весь день")).toHaveLength(2);
  });

  it("reads an empty idle_min as the default, not as 'do not wait for him'", () => {
    // `idle_min:` with nothing after it is null, and `Number(null)` is 0 — so the
    // setting that exists to keep her quiet while he is around turned into its
    // opposite, silently, in the one place that must not fail open.
    const cfg = parseInitiative({
      enabled: true,
      idle_min: null,
      periods: [{ name: "утро", from: "06:00", to: "10:00", per_day: 1 }],
    })!;
    expect(cfg.idleMin).toBe(30);

    const target = targetOffsets(cfg.periods[0], "2026-10-11#утро")[0];
    const after = at(6, target);
    expect(dueNow(cfg, NONE, after, 0, after - 60_000)).toBeNull();

    // An explicit zero still means what it says.
    const eager = parseInitiative({
      enabled: true,
      idle_min: 0,
      periods: [{ name: "утро", from: "06:00", to: "10:00", per_day: 1 }],
    })!;
    expect(eager.idleMin).toBe(0);
    expect(dueNow(eager, NONE, after, 0, after - 60_000)).not.toBeNull();
  });
});
