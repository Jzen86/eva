/**
 * What `shell` and `ssh` may run without asking.
 *
 * The previous version carried a blocklist of four strings — "rm -rf /", "mkfs",
 * "dd if=", "format" — and ran everything else. That is backwards, and not
 * because of the four strings: a blocklist can only name what someone already
 * thought of. `sh -c`, `find -delete`, `xargs`, a variable holding a name, a
 * `curl -T` upload — all of it walked straight through, and the whole thing
 * looked like safety while changing nothing about the actual risk. It is gone.
 *
 * The load is inverted here: a command runs on its own only if it is made of
 * binaries that cannot write anything in any mode. Everything else is parked
 * for the owner with /yes. A command the model got wrong then costs one tap
 * instead of the box, and the two failure modes are no longer symmetric — one
 * is a wasted confirmation, the other is silent and unrecoverable.
 *
 * The rule I applied to myself: if I cannot say with confidence that a binary
 * does not write, it is not on the list. That is why there is no `git`, `curl`,
 * `docker` or `npm` in here even in their read-only modes — each of them has
 * enough write modes, flags and hidden subcommands that a table of them would
 * be a fiction. `/yes` is one tap; a wrong guess is the machine. The owner's
 * own machine, to be clear: this gates what the bot does unprompted, not what
 * the owner can do.
 *
 * `tools.shell_trust` widens the list for a specific install, and it is called
 * that rather than "allow" on purpose. A name there means "its write modes run
 * unattended too" — `git` in that list means `git push` runs unattended. It is
 * a trust decision, not a safety setting, and `doctor` prints what is in it so
 * it is not a decision someone made once and forgot.
 */

export type ShellVerdict =
  | { kind: "allow" }
  | { kind: "gate"; why: string };

/**
 * Binaries that cannot write, in any mode.
 *
 * Chosen for that property, not for usefulness: each one is a formatter or a
 * reader. `tail -f` returns nothing and needs a timeout, which is a
 * inconvenience, not a risk.
 */
const READ_ONLY_BINARIES = new Set([
  // reading and listing
  "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "lsblk", "blkid",
  "lsof", "tree", "nl", "tac", "fold", "expand", "column",
  // text
  "grep", "egrep", "fgrep", "sort", "uniq", "cut", "tr", "diff", "cmp",
  "md5sum", "sha1sum", "sha256sum", "cksum",
  // identity and state
  "whoami", "id", "date", "uname", "uptime", "hostname", "printenv",
  "which", "type", "pwd", "basename", "dirname", "realpath", "readlink",
  "getconf", "nproc", "seq", "sleep", "true", "false",
  // output. These write to stdout and nowhere else; a `>` next to them is a
  // redirect, which is caught structurally before any of this is consulted.
  "echo", "printf", "yes",
  // processes
  "ps", "pgrep", "free", "vmstat", "iostat", "mpstat", "uptime", "lsof",
  // system state
  "dmesg", "lsmod", "modinfo", "sysctl", "uname", "lscpu", "lspci", "lsusb",
  // network
  "ss", "netstat", "ifconfig", "ip", "ping", "getent", "dig", "nslookup", "host",
  // logs
  "journalctl",
]);

/** `ip` writes routes; only the read-only sub-forms belong. */
READ_ONLY_BINARIES.delete("ip");

/** `sysctl` writes kernel parameters; only reads belong. */
READ_ONLY_BINARIES.delete("sysctl");

/** Verbs that turn a read-only binary into a writer when it takes one. */
interface BinaryRule {
  /** The sub-verbs that are read-only. Empty means the whole binary is. */
  subcommands?: string[];
  /** Flags that turn this call into a write. Matched against the raw command. */
  writeFlags?: RegExp;
}

const RULES: Record<string, BinaryRule> = {
  systemctl: {
    subcommands: [
      "status", "is-active", "is-enabled", "is-failed", "show", "cat",
      "list-units", "list-unit-files", "list-timers", "list-sockets",
      "list-jobs", "get-default",
    ],
  },
  journalctl: {
    // Reading logs is the whole reason this binary is here. Trimming them is
    // deletion wearing a log tool's clothes.
    writeFlags: /(^|\s)--vacuum/,
  },
  find: {
    // `find` can delete, can execute anything, and can write its own output to
    // a file. All four are the same command with one more flag.
    writeFlags: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
  },
};

/** The dot-commands of sqlite3 that only read. */
const SQLITE_READ_COMMANDS = new Set([".schema", ".tables", ".indexes", ".fullschema", ".mode", ".headers", ".help"]);

/** Words that turn SQL into a write. */
const SQL_WRITE_WORDS =
  /\b(insert|update|delete|drop|alter|create|replace|vacuum|reindex|attach|detach|pragma)\b/i;

export interface ShellShape {
  segments: string[];
  /** Structural reasons the command cannot be read segment by segment. */
  unsafe: string[];
}

/**
 * Break a command into the pieces a shell would run, without running one.
 *
 * Quote-aware, because `grep "a; b" file` is one command and splitting it into
 * two is how a classifier ends up approving something nobody wrote. Unbalanced
 * quotes return null rather than a guess: a command we cannot parse is a
 * command we do not recognize.
 */
export function shapeOf(command: string): ShellShape | null {
  const segments: string[] = [];
  const unsafe: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let sawSubstitution = false;
  let sawRedirect = false;
  let background = false;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 1;
      continue;
    }
    if (ch === "`") {
      sawSubstitution = true;
      current += ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      sawSubstitution = true;
      current += ch;
      continue;
    }
    if (ch === ">" || ch === "<") {
      sawRedirect = true;
      current += ch;
      continue;
    }
    if (ch === ";") {
      push();
      continue;
    }
    if (ch === "\n") {
      push();
      continue;
    }
    if (ch === "|") {
      push();
      if (command[i + 1] === "|") i += 1;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        push();
        i += 1;
        continue;
      }
      background = true;
      push();
      continue;
    }
    current += ch;
  }

  if (quote) return null;
  push();

  if (sawSubstitution) unsafe.push("подстановка команды");
  if (sawRedirect) unsafe.push("перенаправление вывода");
  if (background) unsafe.push("запуск в фоне");

  return { segments, unsafe };
}

/**
 * The binary a segment runs, as a bare name.
 *
 * Leading `FOO=bar` assignments are skipped, because `LC_ALL=C ls` is `ls` and
 * judging it by the first token would gate a harmless command.
 */
export function leadingBinary(segment: string): string | null {
  const tokens = segment.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  const first = tokens[i];
  if (!first || first.startsWith("-")) return null;
  const name = first.split("/").pop() ?? first;
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

/**
 * The sub-verb after the binary: `systemctl status eva` → `status`.
 *
 * The first non-flag token, so `systemctl --user status eva` is still read as
 * `status` rather than gated for having a global flag in front of it.
 */
function subcommandOf(segment: string): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  for (let j = i + 1; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (!token || token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function sqliteWrites(segment: string): boolean {
  // A dot-command is how sqlite3 does things that are not SQL, including
  // `.shell rm -rf` and `.backup /somewhere`.
  for (const token of segment.split(/\s+/).slice(1)) {
    if (token.startsWith(".")) {
      const cmd = token.split("(")[0];
      if (!SQLITE_READ_COMMANDS.has(cmd)) return true;
    }
    if (SQL_WRITE_WORDS.test(token)) return true;
  }
  return false;
}

/**
 * Decide whether a whole command line may run unattended.
 *
 * Every segment must pass. A pipeline is only as safe as its least safe link,
 * and the point of splitting at all is that `ls | xargs rm` contains a writer
 * even though the first half is innocent.
 */
export function classify(command: string, trusted: string[] = []): ShellVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "gate", why: "пустая команда" };

  const shape = shapeOf(trimmed);
  if (!shape) return { kind: "gate", why: "не сбалансированы кавычки — разбирать нечем" };
  if (shape.unsafe.length) {
    return { kind: "gate", why: `${shape.unsafe.join(" + ")}: не чистое чтение` };
  }
  if (shape.segments.length === 0) return { kind: "gate", why: "пустая команда" };

  // A trusted binary is not judged at all, writes included — that is what
  // trusting one means, and pretending otherwise would give the owner the
  // feeling of a safety net that is not there.
  const trustedBins = new Set(trusted.map((b) => b.split("/").pop() ?? b));

  for (const segment of shape.segments) {
    const bin = leadingBinary(segment);
    if (!bin) {
      return { kind: "gate", why: `непонятно, что запускается: «${clip(segment)}»` };
    }

    if (trustedBins.has(bin)) continue;

    const rule = RULES[bin];
    if (rule) {
      if (rule.subcommands) {
        const verb = subcommandOf(segment);
        if (!verb) {
          return { kind: "gate", why: `«${bin}» без подкоманды — не знаю, читает она или пишет` };
        }
        if (!rule.subcommands.includes(verb)) {
          const sample = rule.subcommands.slice(0, 4).join(", ");
          return { kind: "gate", why: `«${bin} ${verb}» пишет; читать можно: ${sample}` };
        }
      }
      if (rule.writeFlags?.test(segment)) {
        return { kind: "gate", why: `«${bin}» вызван с флагом, который пишет` };
      }
      continue;
    }

    if (READ_ONLY_BINARIES.has(bin)) continue;

    if (bin === "sqlite3") {
      if (sqliteWrites(segment)) {
        return { kind: "gate", why: "SQL-запрос или команда sqlite3 пишет в базу" };
      }
      continue;
    }

    return { kind: "gate", why: `«${bin}» не в списке только-чтения` };
  }

  return { kind: "allow" };
}

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The command as it should appear on the owner's approval line. */
export function approvalSummary(prefix: string, command: string): string {
  return `${prefix}: ${clip(command, 120)}`;
}
