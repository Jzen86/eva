import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SchedulerStore } from "../../../src/core/tools/scheduler-store.js";
import { SchedulerService, nextCronRun } from "../../../src/core/tools/scheduler.js";

let db: Database.Database;
let store: SchedulerStore;
let scheduler: SchedulerService;

// The owner's clock against UTC, as the live install has it. Passed explicitly:
// the service has no sensible default, because "wrong zone" is exactly the bug
// these tests exist to hold.
const OWNER_OFFSET = 4;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SchedulerStore(db);
  store.init();
  scheduler = new SchedulerService(store, () => OWNER_OFFSET);
});

afterEach(() => {
  scheduler.stop();
  db.close();
});

describe("SchedulerService", () => {
  it("adds an 'at' task via tool", async () => {
    scheduler.setMessageContext("telegram", "42", []);
    const tool = scheduler.tool;
    const result = await tool.execute({
      action: "add", name: "reminder",
      schedule_type: "at", at: "+5m",
      command: "Напомни про деплой",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("reminder");

    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].channel).toBe("telegram");
    expect(tasks[0].chatId).toBe("42");
  });

  it("adds a 'cron' task via tool (backward compat)", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "daily",
      cron_expression: "0 20 * * *",
      command: "Сводка",
    });
    expect(result.success).toBe(true);
    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    const schedule = JSON.parse(tasks[0].schedule);
    expect(schedule.kind).toBe("cron");
  });

  it("adds an 'every' task", async () => {
    scheduler.setMessageContext("browser", "ws-1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "check-site",
      schedule_type: "every", every: "30m",
      command: "Проверь сайт",
    });
    expect(result.success).toBe(true);
    const schedule = JSON.parse(store.list()[0].schedule);
    expect(schedule.kind).toBe("every");
    expect(schedule.everyMs).toBe(1_800_000);
  });

  it("lists tasks", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "t1", schedule_type: "at", at: "+5m", command: "a",
    });
    const result = await scheduler.tool.execute({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("t1");
  });

  it("removes a task by name", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "to-remove", schedule_type: "at", at: "+5m", command: "x",
    });
    const result = await scheduler.tool.execute({ action: "remove", name: "to-remove" });
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("captures conversation context", async () => {
    scheduler.setMessageContext("telegram", "1", [
      { role: "user", content: "Надо задеплоить проект" },
      { role: "assistant", content: "Окей, когда?" },
      { role: "user", content: "Напомни через 5 минут" },
    ]);
    await scheduler.tool.execute({
      action: "add", name: "deploy-reminder",
      schedule_type: "at", at: "+5m", command: "Напомни про деплой",
    });
    const task = store.list()[0];
    expect(task.context).toContain("Надо задеплоить");
    expect(task.context).toContain("Напомни через 5 минут");
  });

  it("fires due tasks and calls callback", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    // Add task and manually set it to past via store
    await scheduler.tool.execute({
      action: "add", name: "now-task",
      schedule_type: "at", at: "+1m",
      command: "fire now",
    });
    // Force nextRunAt to past so tick fires it
    const task = store.list()[0];
    store.updateNextRun(task.id, Date.now() - 1000, null);

    // Manually trigger tick
    await scheduler.tick();
    expect(fired).toContain("now-task");
    // One-shot task should be deleted
    expect(store.list()).toHaveLength(0);
  });

  it("advances nextRunAt for 'every' tasks after fire", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    await scheduler.tool.execute({
      action: "add", name: "repeater",
      schedule_type: "every", every: "10m",
      command: "repeat",
    });

    // Manually set nextRunAt to past so tick fires it
    const task = store.list()[0];
    store.updateNextRun(task.id, Date.now() - 1000, null);

    await scheduler.tick();
    expect(fired).toContain("repeater");

    // Task should still exist with future nextRunAt
    const updated = store.list();
    expect(updated).toHaveLength(1);
    expect(updated[0].nextRunAt).toBeGreaterThan(Date.now());
  });

  it("recoverMissed executes missed one-shot and skips recurring", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    // Add one-shot task in the past (manually via store)
    const now = Date.now();
    store.add({
      id: "missed-at", name: "missed-oneshot",
      schedule: JSON.stringify({ kind: "at", at: now - 60_000 }),
      command: "missed", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 60_000, lastRunAt: null, createdAt: now - 120_000,
    });
    // Add recurring task in the past
    store.add({
      id: "missed-every", name: "missed-recurring",
      schedule: JSON.stringify({ kind: "every", everyMs: 300_000 }),
      command: "repeat", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 60_000, lastRunAt: null, createdAt: now - 120_000,
    });

    await scheduler.recoverMissed();

    // One-shot was fired and deleted
    expect(fired).toContain("missed-oneshot");
    // Recurring was NOT fired, but nextRunAt was advanced
    expect(fired).not.toContain("missed-recurring");
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("missed-recurring");
    expect(remaining[0].nextRunAt).toBeGreaterThan(now);
  });

  it("skips a task with a corrupt schedule instead of stopping the loop", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    const now = Date.now();
    store.add({
      id: "broken", name: "broken",
      schedule: "{not json",
      command: "x", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });
    store.add({
      id: "good", name: "good",
      schedule: JSON.stringify({ kind: "at", at: now - 1000 }),
      command: "y", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });

    // tick() is called from setInterval with no catch: a throw here was an
    // unhandled rejection, and it also skipped every task after the bad row.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(fired).toContain("good");
    expect(fired).not.toContain("broken");
  });
  it("names the moment on the owner's clock, not the server's", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "evening", schedule_type: "at", at: "2026-10-15T20:00",
      command: "спокойной ночи",
    });
    expect(result.success).toBe(true);
    // 20:00 is his evening: the server's `toLocaleString()` said 16:00 (its own
    // UTC clock, in a foreign format) and the reminder itself fired four hours off.
    expect(result.output).toContain("15.10.2026 20:00");
  });

  it("tells the model when a cron will actually run, in the owner's clock", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "morning", cron_expression: "0 6 * * *", command: "доброе утро",
    });
    expect(result.success).toBe(true);
    // "каждый день в 6 утра" means six to *him*.
    expect(result.output).toMatch(/ближайший запуск — \d{2}\.\d{2}\.\d{4} 06:00/);
  });

  it("refuses a cron that can never fire instead of running it daily", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const before = store.list().length;
    const result = await scheduler.tool.execute({
      action: "add", name: "never", cron_expression: "0 0 30 2 *", command: "никогда",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("parse_error");
    expect(store.list()).toHaveLength(before);
  });

  it("refuses a cron field it cannot read (a name where a number belongs)", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "weekdays", cron_expression: "0 9 * * MON", command: "работа",
    });
    expect(result.success).toBe(false);
    // The old parser dropped "MON" into an empty set, which matched nothing — and
    // the empty scan then produced "once a day from now" with nobody told.
    expect(result.output).toContain("holds no values");
  });

  it("refuses a zero-step cron instead of hanging on it", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    // `i += 0` in the field parser never terminates: one of these from the model
    // would stop the whole bot, tick and turn together.
    const result = await scheduler.tool.execute({
      action: "add", name: "hang", cron_expression: "*/0 * * * *", command: "x",
    });
    expect(result.success).toBe(false);
  });

  it("says how often an interval is in words, not in fractions", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "often", schedule_type: "every", every: "30s", command: "x",
    });
    const result = await scheduler.tool.execute({ action: "list" });
    expect(result.output).toContain("каждые 30с");
  });

  it("collapses whitespace in a task name", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "self\nwatch", schedule_type: "every", every: "12h", command: "x",
    });
    // The name reaches a report heading and the journal line; a newline in it used
    // to forge an entry in both.
    expect(store.list()[0].name).toBe("self watch");
    const removed = await scheduler.tool.execute({ action: "remove", name: "self\nwatch" });
    expect(removed.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("parks a task with an unknown schedule kind instead of firing it every tick", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    const now = Date.now();
    store.add({
      id: "odd", name: "odd",
      schedule: JSON.stringify({ kind: "daily" }),
      command: "x", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });

    // No branch used to match this kind, so the row kept its past `nextRunAt`: the
    // task stayed due on every tick and ran a full turn — with tools, on the
    // owner's money — every thirty seconds, forever.
    await scheduler.tick();
    await scheduler.tick();
    expect(fired).toHaveLength(0);
    expect(store.list()[0].nextRunAt).toBeGreaterThan(now + 300 * 86_400_000);
  });

  it("keeps other tasks running when one schedule is unusable", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    const now = Date.now();
    store.add({
      id: "odd", name: "odd",
      schedule: JSON.stringify({ kind: "cron", expr: "0 0 30 2 *" }),
      command: "x", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });
    store.add({
      id: "good", name: "good",
      schedule: JSON.stringify({ kind: "at", at: now - 1000 }),
      command: "y", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });

    await scheduler.tick();
    expect(fired).toContain("good");
    expect(fired).not.toContain("odd");
  });
});

describe("nextCronRun", () => {
  it("computes next run for daily cron on the owner's clock", () => {
    const now = new Date("2026-03-18T15:00:00Z").getTime();
    // "в 6 утра" for an owner four hours ahead: six on his clock, two on the box's.
    const next = nextCronRun("0 6 * * *", now, 4);
    const onHisClock = new Date(next + 4 * 3_600_000);
    expect(onHisClock.getUTCHours()).toBe(6);
    expect(onHisClock.getUTCMinutes()).toBe(0);
    expect(new Date(next).getUTCHours()).toBe(2);
    expect(next).toBeGreaterThan(now);
    // The zone is the argument's, not the running machine's: five hours further
    // east must mean five hours earlier in real time. (This box is itself on
    // UTC+4, where the old `getHours()` code landed on the right answer by luck.)
    expect(next - nextCronRun("0 6 * * *", now, 9)).toBe(5 * 3_600_000);
  });

  it("reads UTC when the owner is on UTC", () => {
    const now = new Date("2026-03-18T15:00:00Z").getTime();
    const next = nextCronRun("0 20 * * *", now, 0);
    const d = new Date(next);
    expect(d.getUTCHours()).toBe(20);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("computes next run for every-5-minutes cron", () => {
    const now = new Date("2026-03-18T15:02:00Z").getTime();
    const next = nextCronRun("*/5 * * * *", now, 4);
    expect(new Date(next + 4 * 3_600_000).getUTCMinutes() % 5).toBe(0);
    expect(next).toBeGreaterThan(now);
  });

  it("throws rather than guessing when nothing matches within a year", () => {
    const now = new Date("2026-03-18T15:00:00Z").getTime();
    // 30 February never comes; the old fallback made this a daily job.
    expect(() => nextCronRun("0 0 30 2 *", now, 4)).toThrow(/no match within a year/);
  });

  it("throws on a field with no values at all", () => {
    const now = new Date("2026-03-18T15:00:00Z").getTime();
    expect(() => nextCronRun("0 9 * * MON", now, 4)).toThrow(/holds no values/);
    expect(() => nextCronRun("99 * * * *", now, 4)).toThrow(/holds no values/);
  });

  it("throws on a zero step instead of looping forever", () => {
    const now = new Date("2026-03-18T15:00:00Z").getTime();
    expect(() => nextCronRun("*/0 * * * *", now, 4)).toThrow(/holds no values/);
  });
});
