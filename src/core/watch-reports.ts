/**
 * Where her watch reports are kept — one file per task, beside the config.
 *
 * A watch task ("посмотри, что сломалось") is not the two of them talking: it is
 * a report the bot decided to send itself. It already reaches the owner in
 * Telegram, and it already lands in `conversations` like any other turn — that
 * is how the engine keeps its own continuity, and it stays that way. But neither
 * of those is a place to *read later*: the conversation table mixes her reports
 * with every ordinary evening, and scrolling Telegram for them is not a search.
 *
 * So there is a third destination, and it is the one meant to be read:
 * `~/.eva/reports/<task>.md`, appended in date order, task by task. The writer
 * is the scheduler itself, not the model — she cannot forget to save her own
 * report, and it is written *before* the send, so a Telegram failure cannot take
 * the record down with it.
 *
 * Beside the config, like the photo and the database: `EVA_CONFIG_PATH` can move
 * the whole install, and a report written to `~/.eva` while the bot reads
 * `/etc/eva` is the same bug the reference photo already paid for once.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "./config.js";

/** The directory holding one report file per scheduled task. */
export function reportsDir(configPath?: string): string {
  return path.join(path.dirname(configPath ?? getConfigPath()), "reports");
}

/**
 * The report file for one task.
 *
 * The name comes from a database row (`self_watch`, `server_watch`) and ends up
 * in a path, so it is reduced to a safe alphabet rather than trusted. A name
 * with a slash in it would otherwise write outside the directory; a name that is
 * only punctuation would produce a file called `.md`.
 */
export function reportPath(taskName: string, configPath?: string): string {
  const safe = taskName
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[-_.]+/, "")
    .slice(0, 80);
  return path.join(reportsDir(configPath), `${safe || "task"}.md`);
}

/** A stamp in the shape the doctor uses: UTC, minute resolution. */
function stamp(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Append one report to its task's file, and say where it went.
 *
 * Blank text returns `null` and writes nothing: a task that found nothing to say
 * is silence, and an empty dated heading is noise that reads like a report.
 *
 * Returns the file path so the caller can log it — the archive is otherwise
 * invisible from the outside, and "where did it go" should never need a hunt.
 */
export function appendReport(
  taskName: string,
  text: string,
  when: Date = new Date(),
  configPath?: string,
): string | null {
  const body = text.trim();
  if (!body) return null;

  const file = reportPath(taskName, configPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // The heading is flattened the way the path is sanitized, and for the same
  // reason: the name comes from a database row, and reading the archive trusts the
  // heading — a newline in the name would forge a block for another task.
  const heading = taskName.replace(/\s+/g, " ").trim() || "task";
  fs.appendFileSync(file, `\n---\n\n## ${stamp(when)} — ${heading}\n\n${body}\n`);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // No POSIX modes on some filesystems. A report is not a credential, and
    // refusing to save it over a chmod is a worse trade than a loose mode.
  }
  return file;
}

/** What became of one scheduled report: kept, delivered, or neither. */
export interface ReportOutcome {
  /** The file it went to, or `null` when there was nothing to keep. */
  saved: string | null;
  delivered: boolean;
  /** Whatever went wrong, in one line for the log. Absent means both halves held. */
  error?: string;
}

/**
 * Whether a scheduled delivery is an observation at all.
 *
 * The archive exists for reports — the third destination meant to be *read*, so
 * a finding can be found again after the conversation that carried it has been
 * scrolled past. Not every scheduled turn is that: a one-shot reminder is a
 * message, and on 14.10 the wake-up call ("Доброе утро, соня") landed in
 * `reports/14_10.md` beside the server checks. Noise in the reading place is not
 * harmless — it is exactly what makes a real finding get skimmed past.
 *
 * The split is by schedule, not by name: a name is written by whoever set the
 * task up, and hard-coding the watch tasks here would make this file know its
 * callers. A one-shot (`kind: "at"`) is a message and gets only delivered; every
 * periodic form is kept. The rule is deliberately one-sided — a kind this code
 * has never heard of is archived, because losing a check's record is worse than
 * keeping a message's, and an unreadable schedule is kept for the same reason
 * (the scheduler skips such a task, so the branch is unreachable anyway).
 */
export function isReportTask(schedule: string): boolean {
  try {
    const parsed = JSON.parse(schedule) as { kind?: string } | null;
    return parsed?.kind !== "at";
  } catch {
    return true;
  }
}

/**
 * The skeleton of a report, in the one place all the checks read it from.
 *
 * A skeleton, not a form. The owner's own words about it: the report is written "своими
 * словами, а не по моему шаблону. это примерный каркас чтоб выразить идею" — she tells him
 * what happened in her own voice, and the skeleton only guarantees that four things are
 * answerable in it: what was checked (where and how), what was found, what she recommends,
 * and her verdict.
 *
 * He asked for it instead of a retelling, and said why: "суть в том, чтоб я (и ты) понимали
 * что она проверяла, где и как. что нашла, и правильно ли нашла, может найти то что не
 * заметили мы, может дать совет на починку такой какой мы не учли". The reports are also
 * how her capability in this work is judged — which is why "what she looked at" is part of
 * the skeleton and not the wrapping.
 *
 * It lives in code rather than in three task texts so the shape cannot drift apart between
 * the checks: a task text says *what* to look at, this says what the answer has to make
 * visible. And it is compact on purpose — a report is read on a phone, and a wall of text is
 * a report nobody verifies.
 *
 * A clean run answers too. That is a deliberate change from "если всё чисто — ответь ровно
 * [тишина]": silence after a check is indistinguishable from a check that never ran, and the
 * whole point is knowing what she looked at. `[тишина]` stays in the code for messages (the
 * initiative), not for reports.
 */
export const REPORT_SHAPE =
  "Отчёт — своими словами, как рассказываешь человеку; это каркас, а не форма для заполнения. " +
  "В нём должно быть видно четыре вещи:\n" +
  "📝 что ты проверяла — где и как (одна-две строки, чтобы это можно было повторить за тобой);\n" +
  "🆘 серьёзное — то, что по-твоему правда требует нашего вмешательства: что именно и чем грозит; " +
  "⚠️ несерьёзное, но на что стоит обратить внимание: что именно; ✅ ничего — так и скажи, если ни того, " +
  "ни другого. Если есть и серьёзное, и замечания — начни со 🆘, а замечания перечисли отдельной строкой ниже;\n" +
  "💬 что рекомендуешь — поправить, и как именно ты бы это сделала (нечего советовать — не пиши);\n" +
  "📊 твой вердикт — одна-две строки в конце.\n" +
  "Ровно один вердикт из трёх (🆘 / ⚠️ / ✅), по факту, а не по вежливости: 🆘 — это то, что ждёт нашего " +
  "решения, ⚠️ — то, на что стоит взглянуть. Весь отчёт — не больше экрана телефона. Файл, строку и время " +
  "называй там, где есть что чинить; по мелочи хватит одной строки. Отчёт присылай всегда, даже когда всё " +
  "чисто: иначе не видно, смотрела ли ты вообще.";

/**
 * Keep the report, then deliver it — in that order, and on purpose.
 *
 * Sending used to come first, so the archive only ran on the way back, and a
 * Telegram failure lost the report entirely: the one copy meant to survive was
 * written last and only if nothing went wrong. The file is the durable record
 * and the message is the notification, so the record goes first and a failed
 * send leaves it in place.
 *
 * Neither half throws. A scheduled task has no caller to catch for it, and the
 * two failures are independent: a report that could not be saved is still worth
 * sending, and one that could not be sent is still worth reading tomorrow.
 */
export async function archiveThenDeliver(
  taskName: string,
  text: string,
  deliver: () => Promise<void>,
  configPath?: string,
): Promise<ReportOutcome> {
  let saved: string | null = null;
  let error: string | undefined;
  try {
    saved = appendReport(taskName, text, new Date(), configPath);
  } catch (err) {
    error = `архив не записан: ${err instanceof Error ? err.message : String(err)}`;
  }

  let delivered = false;
  try {
    await deliver();
    delivered = true;
  } catch (err) {
    const message = `доставка не удалась: ${err instanceof Error ? err.message : String(err)}`;
    error = error ? `${error}; ${message}` : message;
  }

  return { saved, delivered, ...(error ? { error } : {}) };
}
