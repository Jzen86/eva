/**
 * Initiative: she writes first.
 *
 * She reaches out on her own — a text, a selfie, or nothing — at moments spread
 * across the day, not on a fixed alarm. This module is only the clock and the
 * caps. The day is cut into periods, each with a number of sends allowed, and
 * nothing else: a period carries no scene and no script, because writing one for
 * her would be steering her, not freeing her. What she sends and in what frame
 * is hers to decide, guided by the hour and nothing more.
 *
 * Everything that could turn this into a conveyor lives here, in code, because
 * "не больше двух за утро" is a rule the model must not be trusted to keep:
 *
 *   - a hard per-period cap,
 *   - a minimum gap between any two sends,
 *   - silence while the owner is active,
 *   - and an off switch (`enabled`).
 *
 * Time is local to the owner: the server runs on UTC, `agent.timezone_offset_hours`
 * carries the offset, and every comparison here is made in that local clock.
 * Periods may wrap midnight (22:00–06:00), and a wrapping period is treated as
 * one occurrence: the part after midnight belongs to the evening it started, so
 * the counter does not reset at 00:00 and hand her a second slot.
 */

import { readMeta, writeMeta } from "./memory/db.js";

export interface InitiativePeriod {
  name: string;
  /** Minutes since local midnight. */
  fromMin: number;
  toMin: number;
  /** How many times she may write during this period. */
  perDay: number;
}

export interface InitiativeConfig {
  enabled: boolean;
  /** Stay quiet if the owner wrote within this many minutes. */
  idleMin: number;
  /** Minimum minutes between any two sends, across all periods. */
  minGapMin: number;
  periods: InitiativePeriod[];
}

const STATE_KEY = "initiative_state";

/** "HH:MM" → minutes since midnight, or null when it is not a time. */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min < 0 || min > 59) return null;
  // 24:00 is how a person writes "the end of the day", and the owner's own table
  // says "вечер 20:00–24:00". Accept the bare hour; anything past it does not exist.
  if (h === 24) return min === 0 ? 1440 : null;
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

/**
 * Read the `initiative` block. Returns null when there is nothing usable to run
 * — no periods, or a block so malformed that guessing would be worse than
 * staying quiet. A single bad period is dropped, not the whole feature.
 */
export function parseInitiative(raw: unknown): InitiativeConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const periods: InitiativePeriod[] = [];
  for (const p of Array.isArray(r.periods) ? r.periods : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const fromMin = minutesOfDay(String(o.from ?? ""));
    const toMin = minutesOfDay(String(o.to ?? ""));
    const perDay = Number(o.per_day ?? 1);
    if (fromMin === null || toMin === null || fromMin === toMin) continue;
    if (!Number.isFinite(perDay) || perDay <= 0) continue;
    periods.push({
      name: String(o.name ?? "период").trim() || "период",
      fromMin,
      toMin,
      perDay: Math.min(Math.floor(perDay), 5),
    });
  }
  if (periods.length === 0) return null;
  const num = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  return {
    enabled: r.enabled === true,
    idleMin: Math.max(0, num(r.idle_min, 30)),
    minGapMin: Math.max(0, num(r.min_gap_min, 90)),
    periods,
  };
}

/** Length of the period in minutes, wrap-aware. */
function periodLength(p: InitiativePeriod): number {
  return (p.toMin - p.fromMin + 1440) % 1440;
}

/** Minutes elapsed since the period began, wrap-aware. */
function elapsed(p: InitiativePeriod, min: number): number {
  return (min - p.fromMin + 1440) % 1440;
}

export interface PeriodInstance {
  period: InitiativePeriod;
  /** Stable id of this occurrence — the counter is keyed on it. */
  id: string;
  /** Minutes elapsed inside the occurrence. */
  elapsed: number;
}

/**
 * Which period this local minute falls in, and which occurrence of it.
 *
 * The occurrence id carries the local date it *started* on. For a wrapping
 * period that is the previous calendar day on the morning half, which is what
 * keeps the cap intact across midnight.
 */
export function instanceAt(
  cfg: InitiativeConfig,
  dateKey: string,
  min: number,
): PeriodInstance | null {
  for (const period of cfg.periods) {
    const len = periodLength(period);
    if (len <= 0) continue;
    const el = elapsed(period, min);
    if (el >= len) continue;
    const wraps = period.fromMin > period.toMin;
    const startDate = wraps && min < period.toMin ? previousDateKey(dateKey) : dateKey;
    return { period, id: `${startDate}#${period.name}`, elapsed: el };
  }
  return null;
}

function previousDateKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Local calendar date and minute-of-day for a timestamp. */
export function localClock(now: number, offsetHours: number): { dateKey: string; minutes: number } {
  const shifted = new Date(now + offsetHours * 3600_000);
  return {
    dateKey: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** A tiny deterministic PRNG, so one day picks the same moments every tick. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(key: string): number {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The moments, inside the occurrence, at which she may write: `perDay` offsets
 * in [0, len), sorted. The same occurrence always yields the same set — the
 * randomness is per day, not per tick — so she does not fire twice for one
 * moment, and does not miss it either.
 */
export function targetOffsets(period: InitiativePeriod, instanceId: string): number[] {
  const len = periodLength(period);
  if (len <= 0) return [];
  const rnd = mulberry32(seedOf(instanceId));
  const picked = new Set<number>();
  const want = Math.min(period.perDay, len);
  let guard = 0;
  while (picked.size < want && guard < want * 60) {
    picked.add(Math.floor(rnd() * len));
    guard += 1;
  }
  return [...picked].sort((a, b) => a - b);
}

export interface InitiativeState {
  /** The occurrence the counter belongs to. */
  instanceId: string;
  fired: number;
  lastSentAt: number;
}

const EMPTY_STATE: InitiativeState = { instanceId: "", fired: 0, lastSentAt: 0 };

export function loadState(): InitiativeState {
  const raw = readMeta(STATE_KEY);
  if (!raw) return { ...EMPTY_STATE };
  try {
    const s = JSON.parse(raw) as Partial<InitiativeState>;
    return {
      instanceId: typeof s.instanceId === "string" ? s.instanceId : "",
      fired: Number.isFinite(Number(s.fired)) ? Number(s.fired) : 0,
      lastSentAt: Number.isFinite(Number(s.lastSentAt)) ? Number(s.lastSentAt) : 0,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveState(state: InitiativeState): void {
  writeMeta(STATE_KEY, JSON.stringify(state));
}

export interface InitiativeDue {
  instance: PeriodInstance;
  /** How many of the occurrence's moments have passed. */
  passed: number;
}

/**
 * May she write now? Returns the occurrence when yes.
 *
 * The order matters for the live log: the cap and the two silences are checked
 * before "a moment has arrived", so a turn that is blocked for a reason the
 * owner would recognise (he is right there, or she just wrote) is a block, not
 * "her moment did not come".
 */
export function dueNow(
  cfg: InitiativeConfig,
  state: InitiativeState,
  now: number,
  offsetHours: number,
  lastOwnerMessageAt: number | null,
): InitiativeDue | null {
  if (!cfg.enabled) return null;

  const { dateKey, minutes } = localClock(now, offsetHours);
  const instance = instanceAt(cfg, dateKey, minutes);
  if (!instance) return null;

  const fired = state.instanceId === instance.id ? state.fired : 0;
  if (fired >= instance.period.perDay) return null;

  if (cfg.idleMin > 0 && lastOwnerMessageAt !== null && now - lastOwnerMessageAt < cfg.idleMin * 60_000) {
    return null;
  }
  if (cfg.minGapMin > 0 && state.lastSentAt > 0 && now - state.lastSentAt < cfg.minGapMin * 60_000) {
    return null;
  }

  const targets = targetOffsets(instance.period, instance.id);
  const passed = targets.filter((t) => t <= instance.elapsed).length;
  if (passed <= fired) return null;

  return { instance, passed };
}

/** Consume one moment. Called after a turn actually produced a message. */
export function markSent(state: InitiativeState, instanceId: string, now: number): InitiativeState {
  const fired = (state.instanceId === instanceId ? state.fired : 0) + 1;
  return { instanceId, fired, lastSentAt: now };
}
