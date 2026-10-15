// src/core/tools/scheduler.ts
import { randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "./types.js";
import type { SchedulerStore, ScheduledTaskRow } from "./scheduler-store.js";
import { parseAtTime, parseEveryDuration, parseTimesOfDay } from "./scheduler-parse.js";

// ---------------------------------------------------------------------------
// Cron parser (kept from original)
// ---------------------------------------------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/**
 * One cron field into a set of values.
 *
 * Returns `null` for a field that yields nothing at all (`99`, `MON`). That used
 * to be an empty set, which matches no minute ever — and the scan below then
 * found nothing either, so the caller was handed a made-up "in 24 hours" and a
 * typo became a daily job at an hour nobody chose. A step of zero is worse still:
 * `i += 0` never terminates, and one cron with a zero step would hang the whole
 * bot — this runs inside the tick, and inside the very turn that asked for the task.
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      let start = min;
      let end = max;
      if (stepMatch[1] !== "*") {
        const [s, e] = stepMatch[1]!.split("-").map(Number);
        start = s!; end = e!;
      }
      const step = Number(stepMatch[2]);
      if (!Number.isFinite(step) || step <= 0) return null;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }
    const num = Number(part);
    if (!Number.isNaN(num) && num >= min && num <= max) values.add(num);
  }
  return values.size > 0 ? values : null;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields`);
  }
  const spec: Array<[string, number, number]> = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day of month", 1, 31],
    ["month", 1, 12],
    ["day of week", 0, 6],
  ];
  const sets = parts.map((part, i) => {
    const [name, min, max] = spec[i]!;
    const set = parseField(part, min, max);
    if (!set) {
      throw new Error(
        `Invalid cron expression "${expression}": the ${name} field (${part}) holds no values. ` +
          `Use numbers — days of the week are 0-6 (0 = Sunday), months are 1-12; names like MON are not read.`,
      );
    }
    return set;
  });
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dayOfMonth: sets[2]!,
    month: sets[3]!,
    dayOfWeek: sets[4]!,
  };
}

/**
 * Does the expression match this instant, read on the owner's wall clock?
 *
 * `wallMs` is already shifted by his offset, so its UTC fields *are* his local
 * fields — the same trick `initiative.ts` uses for its periods. Reading plain
 * `getHours()` here meant the box's zone: he says "напоминай каждый день в 6
 * утра", the model writes `0 6 * * *` in the clock her prompt gave her (his), and
 * the reminder arrived at ten because six UTC is ten for him.
 */
function cronMatches(fields: CronFields, wallMs: number): boolean {
  const wall = new Date(wallMs);
  return (
    fields.minute.has(wall.getUTCMinutes()) &&
    fields.hour.has(wall.getUTCHours()) &&
    fields.dayOfMonth.has(wall.getUTCDate()) &&
    fields.month.has(wall.getUTCMonth() + 1) &&
    fields.dayOfWeek.has(wall.getUTCDay())
  );
}

/**
 * Compute the next time a cron expression matches after `afterMs`, on the
 * owner's clock (`offsetHours` against UTC).
 *
 * The scan is a year long, and finding nothing is an error rather than a guess.
 * The old fallback was `afterMs + 24h`, so an expression that can never match —
 * `0 0 30 2 *`, or any typo that emptied a field — quietly became "once a day from
 * now": the same string re-planned itself daily, the report arrived at a random
 * hour, and neither the journal nor the answer to the model mentioned it.
 */
export function nextCronRun(expr: string, afterMs: number, offsetHours: number): number {
  const fields = parseCron(expr);
  const offsetMs = offsetHours * 3_600_000;
  // The first minute strictly after `afterMs`, in his clock by shifting, and back
  // to a real instant on the way out.
  const first = Math.floor((afterMs + offsetMs) / 60_000) * 60_000 + 60_000;
  const maxScan = 366 * 24 * 60;

  for (let i = 0; i < maxScan; i++) {
    const wall = first + i * 60_000;
    if (cronMatches(fields, wall)) return wall - offsetMs;
  }

  throw new Error(
    `Invalid cron expression "${expr}": no match within a year. ` +
      `Check the day and the month — 29 February, for one, is further away than that.`,
  );
}

/**
 * The next of several fixed times of day, on the owner's clock.
 *
 * `minutes` are minutes since his midnight, sorted; the answer is the first one
 * strictly after `now`, which is today's remaining times or tomorrow's first. The
 * arithmetic is the wall-clock trick again: shift into his day, find the minute, shift
 * back out. Times before today's first (or after the last) land on tomorrow, so a list
 * that spans midnight needs nothing special.
 */
export function nextTimesRun(minutes: number[], afterMs: number, offsetHours: number): number {
  if (minutes.length === 0) throw new Error("no times to run at");
  const offsetMs = offsetHours * 3_600_000;
  const wall = afterMs + offsetMs;
  const dayStart = Math.floor(wall / 86_400_000) * 86_400_000;

  for (const minute of minutes) {
    const candidate = dayStart + minute * 60_000;
    if (candidate > wall) return candidate - offsetMs;
  }
  return dayStart + 86_400_000 + minutes[0]! * 60_000 - offsetMs;
}

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

interface ContextMessage {
  role: string;
  content: string;
}

function buildContext(messages: ContextMessage[]): string {
  const MAX_CHARS = 700;
  const lines: string[] = [];
  let totalLen = 0;

  // Most recent first
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = `${messages[i].role}: ${messages[i].content}`;
    if (totalLen + line.length > MAX_CHARS) break;
    lines.unshift(line);
    totalLen += line.length;
    if (lines.length >= 10) break;
  }

  return lines.join("\n");
}

/**
 * A moment on the owner's clock: "15.10.2026 20:00".
 *
 * `toLocaleString()` stood here, and it printed the box's zone in Node's default
 * locale ("10/15/2026, 8:00:00 PM") — a format he never writes, in a day he may
 * not be in. Everything the model is told about a schedule is now in the same
 * clock the schedules are read in.
 */
function stampInOwnerZone(ms: number, offsetHours: number): string {
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms + offsetHours * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "30s" → "30с", "12h" → "12ч". The list used to print `every 0.5m`. */
function formatEvery(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}д`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}ч`;
  if (ms % 60_000 === 0) return `${ms / 60_000}м`;
  return `${Math.round(ms / 1000)}с`;
}

// ---------------------------------------------------------------------------
// SchedulerService
// ---------------------------------------------------------------------------

export type TaskFireCallback = (task: ScheduledTaskRow) => void | Promise<void>;

export class SchedulerService {
  private store: SchedulerStore;
  private ownerOffset: () => number;
  private fireCallback: TaskFireCallback | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  // Mutable message context — set before each tool execution
  private currentChannel = "";
  private currentChatId = "";
  private currentMessages: ContextMessage[] = [];

  /**
   * `ownerOffset` is the owner's clock against UTC, and the only clock this
   * service reads a schedule in (see `nextCronRun` and `parseAtTime`).
   *
   * A function rather than a number on purpose: he can change
   * `agent.timezone_offset_hours` in the chat, and a number captured at boot
   * would keep firing his reminders on the old clock until the next restart,
   * silently — the same stale-read bug the initiative's periods already paid for.
   */
  constructor(store: SchedulerStore, ownerOffset: () => number) {
    this.store = store;
    this.ownerOffset = ownerOffset;
  }

  /** Set current message context. Called by engine before tool execution. */
  setMessageContext(channel: string, chatId: string, messages: ContextMessage[]): void {
    this.currentChannel = channel;
    this.currentChatId = chatId;
    this.currentMessages = messages;
  }

  /** Register callback for when a scheduled task fires. */
  onTaskFire(cb: TaskFireCallback): void {
    this.fireCallback = cb;
  }

  /**
   * Start the 30s ticker.
   *
   * `void … .catch` and not a bare call: `tick` reads SQLite, and a throw from
   * the store used to be an unhandled rejection — which on this Node is the death
   * of the process, taking whatever report was being written with it. The interval
   * does not await, so a long turn cannot stack ticks; a second fire for the same
   * moment is already prevented by advancing the row before the callback.
   */
  start(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      void this.tick().catch((err) => {
        console.error("Scheduler: tick failed:", err instanceof Error ? err.message : err);
      });
    }, 30_000);
    if (this.tickHandle && typeof this.tickHandle === "object" && "unref" in this.tickHandle) {
      (this.tickHandle as NodeJS.Timeout).unref();
    }
  }

  /** Stop the ticker. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Parse a stored schedule, tolerating a corrupt row.
   *
   * tick() runs from setInterval with no catch, so a `JSON.parse` throw was an
   * unhandled rejection, and because it happened before the loop's own try the
   * tasks after the bad row were skipped as well. One hand-edited row could stop
   * the scheduler for everything else.
   */
  private parseSchedule(raw: string): Record<string, any> | null {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
    } catch {
      return null;
    }
  }

  /** Check for due tasks and fire them. Public for testing. */
  async tick(): Promise<void> {
    const now = Date.now();
    let due: ScheduledTaskRow[];
    try {
      due = this.store.getDue(now);
    } catch (err) {
      // tick() runs from setInterval; a store failure must not become the end of
      // the process, and must not stop the tasks that were already read.
      console.error("Scheduler: не могу прочитать задачи:", err instanceof Error ? err.message : err);
      return;
    }

    for (const task of due) {
      const schedule = this.parseSchedule(task.schedule);
      if (!schedule) {
        console.error(`Scheduler: задача "${task.name}" (id ${task.id}) с битым расписанием — пропускаю.`);
        continue;
      }

      // Update DB BEFORE async callback to prevent double-fire
      try {
        this.advance(task, schedule, now, true);
      } catch (err) {
        this.park(task, now, err);
        continue;
      }

      // Fire callback (async, don't block the loop)
      if (this.fireCallback) {
        try {
          await this.fireCallback(task);
        } catch (err) {
          console.error(`Scheduler fire error for "${task.name}":`, err);
        }
      }
    }
  }

  /** Process missed one-shot tasks on startup. */
  async recoverMissed(): Promise<void> {
    const now = Date.now();
    let due: ScheduledTaskRow[];
    try {
      due = this.store.getDue(now);
    } catch (err) {
      console.error("Scheduler: не могу прочитать задачи:", err instanceof Error ? err.message : err);
      return;
    }

    for (const task of due) {
      const schedule = this.parseSchedule(task.schedule);
      if (!schedule) {
        console.error(`Scheduler: задача "${task.name}" (id ${task.id}) с битым расписанием — пропускаю.`);
        continue;
      }

      if (schedule.kind === "at") {
        // Execute missed one-shot
        this.store.deleteById(task.id);
        if (this.fireCallback) {
          try {
            await this.fireCallback(task);
          } catch (err) {
            console.error(`Scheduler recovery error for "${task.name}":`, err);
          }
          // 3s delay between missed tasks
          await new Promise((r) => setTimeout(r, 3000));
        }
      } else {
        // Skip to next future run. A repeating task did not miss its work — it is
        // not caught up on boot, so `lastRunAt` stays untouched.
        try {
          this.advance(task, schedule, now, false);
        } catch (err) {
          this.park(task, now, err);
        }
      }
    }
  }

  /**
   * Move a task's row to its next run, before the callback fires.
   *
   * The order is deliberate and stays: a row advanced *after* the callback would
   * be due again on the next tick, and a turn that takes five minutes would send
   * the same reminder twice. The price is on the other side — a turn that dies
   * takes its task's moment with it, since the row has already moved — and that is
   * the trade we keep, with the failure written to the journal.
   *
   * Throws when the schedule cannot be computed at all (an unknown kind, an
   * impossible cron, a duration that is not one). That used to leave `nextRunAt`
   * in the past, so the task was due on *every* tick and ran a full turn — a check
   * with tools, on the owner's money — every thirty seconds forever.
   */
  private advance(task: ScheduledTaskRow, schedule: Record<string, any>, now: number, ran: boolean): void {
    if (schedule.kind === "at") {
      this.store.deleteById(task.id);
      return;
    }
    this.store.updateNextRun(task.id, this.nextRunAt(schedule, now), ran ? now : null);
  }

  /** When this schedule runs next, in milliseconds. Throws on a schedule that cannot be read. */
  private nextRunAt(schedule: Record<string, any>, now: number): number {
    if (schedule.kind === "every") {
      const everyMs = Number(schedule.everyMs);
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        throw new Error(`everyMs is not a duration (${String(schedule.everyMs)})`);
      }
      return now + everyMs;
    }
    if (schedule.kind === "cron") {
      return nextCronRun(String(schedule.expr), now, this.ownerOffset());
    }
    if (schedule.kind === "times") {
      const raw = Array.isArray(schedule.times) ? schedule.times.join(", ") : String(schedule.times ?? "");
      return nextTimesRun(parseTimesOfDay(raw), now, this.ownerOffset());
    }
    throw new Error(`unknown schedule kind "${String(schedule.kind)}"`);
  }

  /**
   * Take an unusable task out of the firing loop without losing it.
   *
   * It stays in the table — `list` still shows it, and she can see what is wrong
   * with it — a year of silence away, and the journal names the reason. Deleting
   * would be worse: the task is the owner's, and a schedule this code cannot read
   * is not the same thing as a task he no longer wants.
   */
  private park(task: ScheduledTaskRow, now: number, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `Scheduler: задача "${task.name}" (id ${task.id}) — расписание невыполнимо (${reason}); снимаю с расписания.`,
    );
    try {
      this.store.updateNextRun(task.id, now + 365 * 86_400_000, null);
    } catch (parkErr) {
      console.error(
        `Scheduler: не могу снять задачу "${task.name}":`,
        parkErr instanceof Error ? parkErr.message : parkErr,
      );
    }
  }

  /** The Tool instance to register in ToolRegistry. */
  get tool(): Tool {
    return {
      name: "scheduler",
      description:
        "Планировщик задач (напоминания, повторяющиеся задачи). " +
        'schedule_type="at" + at="+5m" для одноразовых, ' +
        'schedule_type="every" + every="30m" для интервалов, ' +
        'schedule_type="cron" + cron_expression="0 20 * * *" для расписаний, ' +
        'schedule_type="times" + times="09:15, 15:00, 21:15, 03:00" для нескольких времён в сутках. ' +
        "Время считается по твоим часам (та же зона, что в промпте). Расписание, которое не сработает никогда, будет отклонено с ошибкой. " +
        "action=add создаёт задачу, action=remove удаляет по имени, action=list показывает все.",
      parameters: [
        { name: "action", type: "string", description: "add, remove, or list", required: true },
        { name: "name", type: "string", description: "Task name (required for add/remove)" },
        { name: "schedule_type", type: "string", description: 'at, every, or cron (default: cron)' },
        { name: "cron_expression", type: "string", description: 'Cron expression for schedule_type=cron, e.g. "0 20 * * *" — по твоим часам' },
        { name: "at", type: "string", description: 'Time for schedule_type=at: "+5m", "+2h", or ISO datetime (без зоны читается по твоим часам)' },
        { name: "times", type: "string", description: 'Times of day for schedule_type=times, e.g. "09:15, 15:00, 21:15, 03:00" — по твоим часам' },
        { name: "every", type: "string", description: 'Interval for schedule_type=every: "30s", "5m", "2h"' },
        { name: "command", type: "string", description: "What to do when the task fires (prompt for the LLM)" },
      ],
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        return this.handleToolCall(params);
      },
    };
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || "").trim();

    switch (action) {
      case "add": return this.handleAdd(params);
      case "remove": return this.handleRemove(params);
      case "list": return this.handleList();
      default:
        return { success: false, output: `Unknown action: ${action}. Use add, remove, or list.`, error: "invalid_action" };
    }
  }

  private handleAdd(params: Record<string, unknown>): ToolResult {
    // Collapse whitespace in the name. It ends up in a report's heading and in the
    // journal line, and a name with a newline in it forges another entry — see
    // watch-reports.ts, which holds the other half of the same rule.
    const name = String(params.name || "").replace(/\s+/g, " ").trim();
    if (!name) return { success: false, output: "Missing: name", error: "missing_param" };

    const command = String(params.command || "").trim();
    if (!command) return { success: false, output: "Missing: command", error: "missing_param" };

    // Determine schedule type — default to "cron" for backward compat
    let scheduleType = String(params.schedule_type || "").trim();
    if (!scheduleType && params.cron_expression) scheduleType = "cron";
    if (!scheduleType) return { success: false, output: "Missing: schedule_type (at, every, or cron)", error: "missing_param" };

    const now = Date.now();
    let schedule: string;
    let nextRunAt: number;

    try {
      switch (scheduleType) {
        case "at": {
          const atStr = String(params.at || "").trim();
          if (!atStr) return { success: false, output: "Missing: at (e.g. \"+5m\")", error: "missing_param" };
          const atMs = parseAtTime(atStr, now, this.ownerOffset());
          schedule = JSON.stringify({ kind: "at", at: atMs });
          nextRunAt = atMs;
          break;
        }
        case "every": {
          const everyStr = String(params.every || "").trim();
          if (!everyStr) return { success: false, output: "Missing: every (e.g. \"30m\")", error: "missing_param" };
          const everyMs = parseEveryDuration(everyStr);
          schedule = JSON.stringify({ kind: "every", everyMs });
          nextRunAt = now + everyMs;
          break;
        }
        case "cron": {
          const expr = String(params.cron_expression || "").trim();
          if (!expr) return { success: false, output: "Missing: cron_expression", error: "missing_param" };
          // Validate by parsing
          parseCron(expr);
          schedule = JSON.stringify({ kind: "cron", expr });
          nextRunAt = nextCronRun(expr, now, this.ownerOffset());
          break;
        }
        case "times": {
          const raw = Array.isArray(params.times)
            ? params.times.join(", ")
            : String(params.times || "").trim();
          if (!raw) return { success: false, output: 'Missing: times (e.g. "09:15, 15:00")', error: "missing_param" };
          const minutes = parseTimesOfDay(raw);
          schedule = JSON.stringify({ kind: "times", times: raw.split(/[,\s;]+/).filter(Boolean) });
          nextRunAt = nextTimesRun(minutes, now, this.ownerOffset());
          break;
        }
        default:
          return { success: false, output: `Invalid schedule_type: ${scheduleType}`, error: "invalid_param" };
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err), error: "parse_error" };
    }

    const context = buildContext(this.currentMessages);

    const task: ScheduledTaskRow = {
      id: randomUUID(),
      name,
      schedule,
      command,
      context,
      channel: this.currentChannel,
      chatId: this.currentChatId,
      nextRunAt,
      lastRunAt: null,
      createdAt: now,
    };

    try {
      this.store.add(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        return { success: false, output: `Task "${name}" already exists. Remove it first or use a different name.`, error: "duplicate" };
      }
      return { success: false, output: msg, error: "db_error" };
    }

    const when = scheduleType === "at"
      ? stampInOwnerZone(nextRunAt, this.ownerOffset())
      : scheduleType === "every"
        ? `каждые ${params.every}`
        : scheduleType === "times"
          ? `${String(params.times)}, ближайший запуск — ${stampInOwnerZone(nextRunAt, this.ownerOffset())}`
          : `${params.cron_expression}, ближайший запуск — ${stampInOwnerZone(nextRunAt, this.ownerOffset())}`;

    return { success: true, output: `Задача "${name}" запланирована (${when}).` };
  }

  private handleRemove(params: Record<string, unknown>): ToolResult {
    const name = String(params.name || "").replace(/\s+/g, " ").trim();
    if (!name) return { success: false, output: "Missing: name", error: "missing_param" };

    const removed = this.store.removeByName(name);
    if (!removed) return { success: false, output: `Task "${name}" not found.`, error: "not_found" };

    return { success: true, output: `Задача "${name}" удалена.` };
  }

  private handleList(): ToolResult {
    const tasks = this.store.list();
    if (tasks.length === 0) return { success: true, output: "Нет запланированных задач." };

    const offset = this.ownerOffset();
    const lines = tasks.map((t) => {
      const sched = this.parseSchedule(t.schedule);
      if (!sched) return `- ${t.name}: [битое расписание] → ${t.command}`;
      const type = sched.kind;
      const next = Number.isFinite(t.nextRunAt) ? `, следующий — ${stampInOwnerZone(t.nextRunAt, offset)}` : "";
      const detail = type === "at" ? stampInOwnerZone(Number(sched.at), offset)
        : type === "every" ? `каждые ${formatEvery(Number(sched.everyMs))}${next}`
        : type === "times" ? `${Array.isArray(sched.times) ? sched.times.join(", ") : String(sched.times)}${next}`
        : `${sched.expr}${next}`;
      // `lastRunAt` is written when the row is advanced, before the callback runs:
      // it says the task was started, not that its turn finished. That is the
      // honest word for it, and it is the only place this field is read at all.
      const ran = t.lastRunAt ? `, прошлый запуск — ${stampInOwnerZone(t.lastRunAt, offset)}` : "";
      return `- ${t.name}: [${type}] ${detail}${ran} → ${t.command}`;
    });
    return { success: true, output: `${tasks.length} задач(а):\n${lines.join("\n")}` };
  }
}
