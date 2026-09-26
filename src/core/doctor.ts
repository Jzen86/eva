/**
 * Self-diagnosis.
 *
 * The reason this exists: almost every bad evening with Eva ended the same
 * way — something was wrong, nothing said what, and the only evidence was a
 * line in a log that had already scrolled past. The knowledge index was stale
 * and search returned nothing, so it looked like she had forgotten. A provider
 * was rate-limited, so it looked like she had stopped trying. The config had
 * lost a field to the repair path, so it looked like a personality change.
 *
 * None of those announce themselves. This walks the things that fail silently
 * and says which one it is, with the fix attached to the finding rather than
 * left to whoever reads the report.
 *
 * Two rules, both learned the hard way:
 *
 * - A check that throws IS the diagnosis. Failures are caught per check and
 *   reported as `bad` with the message, never allowed to abort the run — one
 *   unreachable provider must not hide the state of the database.
 * - Findings are graded, not boolean. A missing `embed` role is a warning
 *   (semantic dedup goes away, everything still works). A role pointing at a
 *   provider with no key is fatal: she is silent from now on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  getConfigPath,
  getConfigDir,
  isConfigured,
  type EvaConfig,
} from "./config.js";
import type { ModelRef, ProviderRegistry } from "./llm/registry.js";

export type Severity = "ok" | "warn" | "bad";

export interface Check {
  /** Machine name, stable enough to grep for. */
  name: string;
  severity: Severity;
  /** One line, says what is true — not what is wrong. */
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: Check[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  ok: number;
  warnings: number;
  bad: number;
  /** True when nothing is broken. Warnings still count as not-clean. */
  healthy: boolean;
}

/** Roles the bot is expected to have, and what breaks without each. */
const EXPECTED_ROLES: Array<{ role: string; required: boolean; note: string }> = [
  { role: "fast", required: true, note: "ежедневная болтовня — без неё я молчу вообще" },
  { role: "strong", required: true, note: "сложные задачи и работа с инструментами" },
  { role: "study", required: false, note: "фоновое обучение — без него память не растёт" },
  { role: "embed", required: false, note: "эмбеддинги — без них дедуп только лексический, это режим, а не поломка" },
];

export interface DoctorOptions {
  registry?: ProviderRegistry;
  configPath?: string;
  dbPath?: string;
  /** Live check of one model. Only run when asked — it costs a request. */
  probe?: (ref: ModelRef) => Promise<{ ok: boolean; ms: number; reason?: string }>;
}

function ok(name: string, detail: string): Check {
  return { name, severity: "ok", detail };
}
function warn(name: string, detail: string, fix?: string): Check {
  return { name, severity: "warn", detail, fix };
}
function bad(name: string, detail: string, fix?: string): Check {
  return { name, severity: "bad", detail, fix };
}

/**
 * A path we can see the size of, or null when it is not there.
 * A missing file and a file we cannot stat are different problems and the
 * report should not blur them.
 */
function describePath(target: string): { exists: boolean; size: number; note?: string } {
  try {
    if (!fs.existsSync(target)) return { exists: false, size: 0 };
    const stat = fs.statSync(target);
    return { exists: true, size: stat.size };
  } catch (err) {
    return { exists: true, size: 0, note: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * First column of the first row, as text.
 *
 * `pragma(name, { simple: true })` gives a bare value in better-sqlite3 but
 * rows in the node:sqlite shim the tests run against. Reading it as a string
 * would compare an array to "ok" and report a healthy database as destroyed —
 * so both shapes are normalised here rather than at each call site.
 */
function pragmaScalar(conn: { pragma(source: string, options?: { simple?: boolean }): unknown }, name: string): string {
  const res = conn.pragma(name, { simple: true });
  if (typeof res === "string") return res;
  if (Array.isArray(res)) {
    const first = res[0] as Record<string, unknown> | undefined;
    if (first) {
      const values = Object.values(first);
      if (values.length === 1) return String(values[0]);
    }
    return res.length === 0 ? "" : String(res[0]);
  }
  return res === undefined || res === null ? "" : String(res);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

/**
 * Russian count agreement: 1 копия, 2 копии, 5 копий.
 *
 * Worth the four lines because every number in this report is read by a person
 * deciding whether to trust it, and "2 копий" is the kind of detail that makes
 * a diagnosis feel machine-written.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** "3 копии" — the number and its noun, agreed. */
function counted(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configSection(configPath: string): DoctorSection {
  const checks: Check[] = [];
  const info = describePath(configPath);

  if (!info.exists) {
    checks.push(
      bad("config.missing", `файла нет: ${configPath}`, "Бот без конфига не поднимется. Проверь EVA_CONFIG_PATH и права."),
    );
    return { title: "Конфиг", checks };
  }
  checks.push(ok("config.present", `${configPath} (${humanBytes(info.size)})`));

  let config: EvaConfig | null = null;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    // An unparseable YAML throws out of loadConfig rather than returning null.
    checks.push(
      bad("config.unreadable", `не читается: ${firstLine(err)}`,
        "Файл есть, но это не валидный YAML. Бэкапы рядом: config.yaml.bak.1 — последний рабочий."),
    );
    return { title: "Конфиг", checks };
  }

  if (!config) {
    checks.push(
      bad("config.unreadable", "файл есть, но не читается как конфиг",
        "Бэкапы рядом: config.yaml.bak.1 — последний рабочий."),
    );
    return { title: "Конфиг", checks };
  }

  checks.push(
    isConfigured(configPath)
      ? ok("config.llm", "ключи LLM на месте")
      : bad("config.llm", "ни одной модели не настроено", "Секция models в config.yaml пустая."),
  );

  // Backups: the whole point of rotating them is being able to say whether
  // there is anything to roll back to.
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let backups: string[] = [];
  try {
    backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak`))
      .sort();
  } catch {
    // Directory unreadable; the file check above already reported what matters.
  }
  checks.push(
    backups.length > 0
      ? ok("config.backups", `${counted(backups.length, "копия", "копии", "копий")}: ${backups.join(", ")}`)
      : warn("config.backups", "бэкапов нет", "Первая же правка конфига их создаст — до этого откатываться нечем."),
  );

  // Secrets: presence and length only. Never the value, not even hashed.
  const secrets: string[] = [];
  for (const [id, spec] of Object.entries(config.providers ?? {})) {
    if (spec?.api_key) {
      secrets.push(`${id}.api_key (${counted(spec.api_key.length, "символ", "символа", "символов")})`);
    }
  }
  if (config.telegram?.token) {
    secrets.push(`telegram.token (${counted(config.telegram.token.length, "символ", "символа", "символов")})`);
  }
  if (config.selfies?.fal_api_key) secrets.push("selfies.fal_api_key");
  checks.push(
    secrets.length > 0
      ? ok("config.secrets", `задано: ${secrets.join(", ")}`)
      : bad("config.secrets", "ни одного ключа не задано", "Без ключей провайдера и токена телеграма я не работаю."),
  );

  // Identity: is there actually a personality, or just a name?
  const p = config.agent?.personality;
  const hasCharacter = Boolean(p?.persona || p?.custom_instructions || p?.tone || p?.style);
  const opsCount = Array.isArray(p?.ops) ? p.ops.length : 0;
  checks.push(
    hasCharacter
      ? ok("config.character", `характер есть${opsCount ? `, ${counted(opsCount, "правило", "правила", "правил")} в ops` : ""}`)
      : warn(
          "config.character",
          "личность не описана — ни persona, ни tone, ни custom_instructions",
          "Я отвечу, но буду generic-ботом. Опиши меня: self_config set agent.personality.persona \"...\"",
        ),
  );

  if (opsCount === 0 && hasCharacter) {
    checks.push(
      warn(
        "config.ops",
        "постоянных правил (ops) нет",
        "Правила, записанные в persona, модель читает как настроение. Перенеси их в ops списком.",
      ),
    );
  }

  const ownerBound = config.telegram?.owner_id !== undefined;
  checks.push(
    ownerBound
      ? ok("config.owner", `владелец привязан (id ${config.telegram?.owner_id})`)
      : bad(
          "config.owner",
          "telegram.owner_id не задан",
          "Без него я не знаю, кому отвечать. Плюс ключ строкой молча выбрасывается при загрузке — пиши числом.",
        ),
  );

  return { title: "Конфиг", checks };
}

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

async function providerSection(
  registry: ProviderRegistry | undefined,
  probe: DoctorOptions["probe"],
): Promise<DoctorSection> {
  const checks: Check[] = [];
  if (!registry) {
    checks.push(warn("providers.registry", "реестр провайдеров недоступен в этом окружении"));
    return { title: "Провайдеры и модели", checks };
  }

  const ids = registry.providerIds();
  if (ids.length === 0) {
    checks.push(bad("providers.none", "провайдеры не настроены", "Секция providers в config.yaml пустая."));
    return { title: "Провайдеры и модели", checks };
  }

  for (const id of ids) {
    const usable = registry.isUsable(id);
    // The id goes in the detail, not just in the check name: the rendered
    // report shows details only, and "не заполнен" without saying which
    // provider is a question, not a diagnosis.
    checks.push(
      usable
        ? ok(`provider.${id}`, `${id}: готов`)
        : bad(`provider.${id}`, `${id}: не заполнен (нужны base_url и api_key)`, `Дописать секцию providers.${id} в config.yaml.`),
    );
  }

  const roles = registry.rolesList();
  if (Object.keys(roles).length === 0) {
    checks.push(bad("models.none", "ни одна роль не назначена", "Без ролей я не знаю, на какой модели говорить."));
  }

  for (const { role, required, note } of EXPECTED_ROLES) {
    const ref = roles[role];
    if (!ref) {
      checks.push(
        (required ? bad : warn)(
          `model.${role}`,
          `роль "${role}" не назначена (${note})`,
          required ? `Назначь: self_config не умеет, попроси владельца или switch_model action=switch role=${role}.`
                   : "Не критично, но эта возможность выключена.",
        ),
      );
      continue;
    }
    const label = registry.label(ref);
    if (!registry.isUsable(ref.provider)) {
      checks.push(bad(`model.${role}`, `роль "${role}" → ${label}, а провайдер не заполнен`));
      continue;
    }
    if (!probe) {
      checks.push(ok(`model.${role}`, `роль "${role}" → ${label}`));
      continue;
    }
    // Only with an explicit probe: this is a real request and costs money.
    const res = await probe(ref);
    checks.push(
      res.ok
        ? ok(`model.${role}`, `роль "${role}" → ${label}, отвечает (${res.ms} мс)`)
        : bad(`model.${role}`, `роль "${role}" → ${label} НЕ ОТВЕЧАЕТ: ${res.reason ?? "неизвестно"}`,
            "Провайдер доступен по ключу, но модель не отвечает. Проверь лимиты, баланс и точное имя модели."),
    );
  }

  const fallbacks = registry.fallbackList();
  checks.push(
    fallbacks.length > 0
      ? ok("models.fallbacks", `${counted(fallbacks.length, "запасная", "запасные", "запасных")}: ${fallbacks.map((f) => registry.label(f)).join(", ")}`)
      : warn("models.fallbacks", "запасных моделей нет",
          "Когда основная упадёт или кончится лимит, я замолчу до перезапуска."),
  );

  return { title: "Провайдеры и модели", checks };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

async function memorySection(dbPath: string | undefined): Promise<DoctorSection> {
  const checks: Check[] = [];

  // Imported lazily, and a failure here is a finding rather than a crash.
  // better-sqlite3 is a native module: it is missing on any box where it was
  // never compiled, and a bot with no loadable database is precisely the
  // situation this report exists to describe. Letting the import throw would
  // lose the provider and config sections too.
  let memory: typeof import("./memory/db.js");
  let knowledge: typeof import("./memory/knowledge.js");
  try {
    memory = await import("./memory/db.js");
    knowledge = await import("./memory/knowledge.js");
  } catch (err) {
    checks.push(
      bad(
        "memory.module",
        "модуль базы не грузится: " + firstLine(err),
        "better-sqlite3 — нативный модуль, его нужно собрать на этой машине " +
          "(npm rebuild better-sqlite3). Память, напоминания и история работают на нём.",
      ),
    );
    return { title: "Память", checks };
  }

  const resolvedDb = dbPath ?? path.join(getConfigDir(), "eva.db");
  const info = describePath(resolvedDb);
  if (!info.exists) {
    checks.push(
      warn("memory.db", `базы нет: ${resolvedDb}`,
        "Создастся при первом запуске. Пустая база — это не поломка, если обучение только начиналось."),
    );
    return { title: "Память", checks };
  }
  checks.push(ok("memory.db", `${resolvedDb} (${humanBytes(info.size)})`));

  // No path means "the connection that is already open", which is what the
  // running bot has. getDB(samePath) also reuses it, but saying so outright
  // keeps the tool from closing a live connection if the default ever moves.
  const conn = memory.getDB(dbPath);

  // integrity_check is the one check that catches a database that has been
  // damaged by something other than a bug — a full disk, a hard kill.
  const integrity = pragmaScalar(conn, "integrity_check");
  checks.push(
    integrity === "ok"
      ? ok("memory.integrity", "целостность в порядке")
      : bad("memory.integrity", `ПОВРЕЖДЕНА: ${integrity}`,
          "Сделай копию файла и восстановись из неё. Откат БД недопустим, пока бот жив."),
  );

  const active = knowledge.getKnowledgeCount(false);
  const retired = knowledge.getKnowledgeCount(true) - active;
  checks.push(
    active > 0
      ? ok(
          "memory.knowledge",
          `${counted(active, "активная запись", "активные записи", "активных записей")}` +
            (retired > 0 ? `, ${counted(retired, "вытеснена", "вытеснено", "вытеснено")}` : ""),
        )
      : warn("memory.knowledge", "ни одной записи в памяти",
          "Либо обучение ещё не работало, либо дедуп съел всё подряд. Проверь модель роли study."),
  );

  // Index version is the check that explains "she forgot everything": the rows
  // are there and the search simply does not match them.
  const stored = Number(memory.readMeta("knowledge_index_version") ?? "0");
  const expected = memory.KNOWLEDGE_INDEX_VERSION;
  checks.push(
    stored >= expected
      ? ok("memory.index", `индекс актуален (версия ${stored})`)
      : bad("memory.index", `индекс устарел: база на версии ${stored}, код ждёт ${expected}`,
          "Пересоберится при следующем открытии базы. Если не помогло — перезапусти бота."),
  );

  // Whether search can still find what is stored.
  //
  // Both of the obvious checks are lying instruments here, and it is worth
  // writing down why, because they look correct:
  //
  // - `count(*)` over knowledge_fts reads the content table, because the table
  //   is an external-content FTS5 view over `knowledge`. It returns the full row
  //   count even when the index is completely empty.
  // - FTS5's own `integrity-check` also passes on an empty index: an index with
  //   nothing in it is internally consistent. It catches corruption, not
  //   desynchronisation, and desynchronisation is the failure that matters.
  //
  // So the check is behavioural, and cheap: take a few recent rows, take a word
  // out of each one's own index text, and ask the index for that row. If it
  // comes back nothing, memory search is broken no matter what it reports about
  // its own health.
  const sample = conn
    .prepare("SELECT id, stems FROM knowledge WHERE superseded_at IS NULL AND stems != '' ORDER BY id DESC LIMIT 5")
    .all() as Array<{ id: number; stems: string }>;

  if (sample.length > 0) {
    let unreachable = 0;
    let parsed = 0;
    for (const row of sample) {
      // Long enough to be a real word: one- and two-letter tokens are stopword
      // noise and would report a miss that is not a fault.
      const term = row.stems.split(/\s+/).find((t) => t.length >= 3);
      if (!term) continue;
      try {
        // Quoted, so a token carrying FTS5 punctuation cannot break the parse.
        const hit = conn
          .prepare("SELECT 1 AS ok FROM knowledge_fts WHERE knowledge_fts MATCH ? AND rowid = ?")
          .get(`"${term}"`, row.id) as { ok: number } | undefined;
        parsed++;
        if (!hit) unreachable++;
      } catch {
        // A term we cannot parse says nothing about the index. Skipping is
        // better than reporting a desync we did not observe.
      }
    }
    checks.push(
      unreachable > 0
        ? warn(
            "memory.fts",
        `поиск не находит ${unreachable} из ${parsed} проверенных записей — индекс рассинхронизирован`,
            "Память выглядит забытой: записи лежат в таблице, но поиск их не выдаёт. " +
              "Пересобери индекс: выполни в базе DELETE FROM knowledge_fts; — при следующем " +
              "открытии базы migrateKnowledgeIndex заполнит его заново.",
          )
        : ok("memory.fts", `поиск находит свои записи (проверено ${parsed})`),
    );
  } else {
    const anyRows = active > 0;
    checks.push(
      anyRows
        ? warn("memory.fts", "в записях памяти пустой индексный текст — индекс не строился",
            "Поиск не сработает, пока стемы не заполнены. Удали eva.db и перезапусти бота, " +
            "чтобы база собралась заново.")
        : ok("memory.fts", "нечего проверять — в памяти пока пусто"),
    );
  }

  // Corruption of the index itself, as opposed to a stale one. Cheap next to
  // the check above, and the failure it finds is the one that cannot be
  // repaired by rebuilding.
  try {
    conn.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('integrity-check')");
    checks.push(ok("memory.fts.integrity", "структура индекса цела"));
  } catch (err) {
    checks.push(
      bad(
        "memory.fts.integrity",
        `индекс повреждён: ${firstLine(err)}`,
        "Сделай копию файла базы и восстановись из неё — пересборка индекса не поможет. " +
          "Откат БД недопустим, пока бот жив.",
      ),
    );
  }

  // getZoneCoverage returns counts per zone, not percentages. Sorting by size
  // puts the themes she actually knows about first, which is the useful
  // reading of "is my memory working".
  const coverage = knowledge.getZoneCoverage();
  if (coverage.size > 0) {
    const lines = [...coverage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([zone, count]) => `${zone}: ${count}`)
      .join(", ");
    checks.push(ok("memory.zones", `темы: ${lines}`));
  }

  try {
    const convos = conn.prepare("SELECT count(*) AS n FROM conversations").get() as
      | { n: number }
      | undefined;
    const n = convos?.n ?? 0;
    checks.push(ok("memory.conversations", `${counted(n, "сообщение", "сообщения", "сообщений")} в истории`));
  } catch {
    // Older databases may not have the table; not worth a finding.
  }

  return { title: "Память", checks };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function runtimeSection(): DoctorSection {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? ok("runtime.node", `node ${process.version}`)
      : bad("runtime.node", `node ${process.version}, а нужно >= 20`, "Обнови node."),
  );

  const uptimeH = (process.uptime() / 3600).toFixed(1);
  checks.push(ok("runtime.uptime", `работаю ${uptimeH} ч`));

  const rss = process.memoryUsage().rss;
  checks.push(
    rss < 1024 * 1024 * 1024
      ? ok("runtime.memory", `RSS ${humanBytes(rss)}`)
      : warn("runtime.memory", `RSS ${humanBytes(rss)} — много для бота, возможна утечка`,
          "Посмотри, не растёт ли память между перезапусками."),
  );

  // The config dir has to be writable or every setting change fails at the
  // worst possible moment, with an error only the owner will ever see.
  const dir = getConfigDir();
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    checks.push(ok("runtime.config_writable", `${dir} доступен для записи`));
  } catch {
    checks.push(
      bad("runtime.config_writable", `${dir} недоступен для записи`,
        "Любая правка настроек будет падать. Проверь владельца и права."),
    );
  }

  let free = 0;
  try {
    // Windows and Linux disagree about the field name; try both.
    const s = fs.statfsSync?.(dir) as { bavail?: number; bsize?: number } | undefined;
    if (s?.bavail && s.bsize) free = s.bavail * s.bsize;
  } catch {
    // statfs is not everywhere; not worth a finding on its own.
  }
  if (free > 0) {
    checks.push(
      free > 200 * 1024 * 1024
        ? ok("runtime.disk", `свободно ${humanBytes(free)}`)
        : warn("runtime.disk", `свободно всего ${humanBytes(free)}`,
            "Забитый диск ломает и запись конфига, и базу. SQLite начинает падать первым."),
    );
  }

  return { title: "Окружение", checks };
}

// ---------------------------------------------------------------------------

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const configPath = opts.configPath ?? getConfigPath();

  /**
   * Each section is guarded, so one exploding section cannot take the report
   * with it. The whole value of a diagnosis is the parts that did answer: a
   * missing database must not also hide that the provider key is wrong.
   */
  const sections: DoctorSection[] = [];
  sections.push(
    await section("Конфиг", "section.config", () => configSection(configPath)),
  );
  sections.push(
    await section("Провайдеры и модели", "section.providers", () =>
      providerSection(opts.registry, opts.probe),
    ),
  );
  sections.push(await section("Память", "section.memory", () => memorySection(opts.dbPath)));
  sections.push(await section("Окружение", "section.runtime", () => runtimeSection()));

  const all = sections.flatMap((s) => s.checks);
  const bad_ = all.filter((c) => c.severity === "bad").length;
  const warn = all.filter((c) => c.severity === "warn").length;

  return {
    sections,
    ok: all.length - bad_ - warn,
    warnings: warn,
    bad: bad_,
    healthy: bad_ === 0,
  };
}

/** Build a section, turning a throw into a section holding the throw. */
async function section(
  title: string,
  name: string,
  build: () => DoctorSection | Promise<DoctorSection>,
): Promise<DoctorSection> {
  try {
    return await build();
  } catch (err) {
    const known = explain(err);
    return {
      title,
      checks: [
        bad(
          name,
          // One line. Native-module loaders like to list every path they tried,
          // and fourteen lines of "Tried:" is not a report, it is a scrollback.
          known?.what ?? `раздел не отработал: ${firstLine(err)}`,
          known?.do ?? "Скорее всего, это и есть поломка. Начни отсюда.",
        ),
      ],
    };
  }
}

/**
 * The failures a fresh install actually hits, translated into what to do.
 *
 * better-sqlite3 compiles from source, and on a bare Linux box that needs a
 * toolchain. Without it the loader says "Could not locate the bindings file.
 * Tried:" and then lists fourteen paths — which tells the person nothing about
 * the one thing that would have fixed it. This is the most likely first-run
 * failure there is, so it gets a sentence instead of a search.
 */
const KNOWN_FAILURES: Array<{ match: RegExp; what: string; do: string }> = [
  {
    match: /bindings file|NODE_MODULE_VERSION|better_sqlite3\.node|ERR_DLOPEN_FAILED|compiled against a different Node/i,
    what: "не собралась нативная часть better-sqlite3 — память работать не будет",
    do: "Поставь тулчейн и переустанови: apt install -y build-essential python3 && npm i -g github:Jzen86/eva",
  },
  {
    match: /EACCES|permission denied/i,
    what: "нет прав на файлы бота",
    do: "Сервис должен ходить от того же пользователя, которому принадлежит ~/.eva",
  },
  {
    match: /ENOSPC|no space left/i,
    what: "кончилось место на диске",
    do: "Освободи место, потом запусти eva doctor ещё раз",
  },
  {
    match: /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i,
    what: "сеть недоступна",
    do: "Проверь DNS и прокси: curl -I https://api.telegram.org",
  },
];

function explain(err: unknown): { what: string; do: string } | undefined {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code ?? "" : "";
  const text = err instanceof Error ? `${err.message}\n${code}` : String(err);
  const hit = KNOWN_FAILURES.find((f) => f.match.test(text));
  return hit ? { what: hit.what, do: hit.do } : undefined;
}

/** Exported for tests: which of the known first-install failures this is. */
export const explainFailure = explain;

/** The first line of an error, no matter how it was stringified. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? text).trim();
}

const MARK: Record<Severity, string> = { ok: "✅", warn: "⚠️ ", bad: "❌" };

/** Render a report for a human. Compact: a phone screen, not a log file. */
export function formatReport(report: DoctorReport, configPath?: string): string {
  const lines: string[] = [];
  if (configPath) lines.push(`Диагностика: ${configPath}`, "");

  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push(`── ${section.title} ──`);
    for (const c of section.checks) {
      lines.push(`${MARK[c.severity]} ${c.detail}`);
      if (c.fix && c.severity !== "ok") lines.push(`   → ${c.fix}`);
    }
    lines.push("");
  }

  // Broken first: a phone screen shows the top, and a passing bot buried under
  // a wall of green ticks is the wrong thing to read first.
  const problems = report.sections
    .flatMap((s) => s.checks)
    .filter((c) => c.severity !== "ok");
  if (problems.length > 0) {
    lines.push("── Что чинить ──");
    problems
      .filter((c) => c.severity === "bad")
      .forEach((c, i) => lines.push(`${i + 1}. ${c.name} — ${c.fix ?? c.detail}`));
    lines.push("");
  }

  const verdict = report.bad > 0
    ? `❌ сломано: ${report.bad}`
    : report.warnings > 0
      ? `⚠️ работаю с оговорками: ${report.warnings}`
      : "✅ всё в порядке";
  lines.push(`${verdict} (проверок: ${report.ok + report.warnings + report.bad}, ок: ${report.ok})`);

  return lines.join("\n");
}
