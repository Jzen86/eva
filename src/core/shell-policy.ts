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

import fs from "node:fs";
import path from "node:path";
import { defaultPathPolicy, expandHome, realPath, type PathPolicy } from "./path-policy.js";

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
  // shell builtins that only move the cursor or the stream. `cd` is here for a
  // measured reason: on the live install it was the fourth most-used first word
  // in a shell call, and `cd /tmp && ls` is the commonest way to write one. It
  // was missing, so every command of that shape was parked for /yes over a
  // builtin that writes nothing — the approval prompt teaching the owner to
  // stop reading them.
  "cd", "pushd", "popd",
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

/** `ifconfig eth0 down` changes interface state; it is not a reader. */
READ_ONLY_BINARIES.delete("ifconfig");

/** `hostname <name>` renames the box; only the bare/short forms read. */
READ_ONLY_BINARIES.delete("hostname");

/** Verbs that turn a read-only binary into a writer when it takes one. */
interface BinaryRule {
  /** The sub-verbs that are read-only. Empty means the whole binary is. */
  subcommands?: string[];
  /** Flags that turn this call into a write. Matched against the raw command. */
  writeFlags?: RegExp;
  /**
   * Flags that take a value, so the token after them is not the sub-verb.
   *
   * `git -C /opt/eva log` made the reader take `-C`'s value as the verb, fail to
   * find `/opt/eva` among the read verbs and park a plain history read — twice in
   * a row, because the retry was the same command, which read to the owner as a
   * confirmation that had stopped working.
   */
  valueFlags?: string[];
  /**
   * Flags that make the *bare* form a read, for binaries whose sub-verb is
   * optional. `systemctl --failed` is `list-units --failed` with the verb left
   * out; the sub-verb reader finds no verb there and used to park it, which is
   * how the server check came back asking the owner for a `/yes` over a listing.
   */
  bareReadFlags?: RegExp;
}

const RULES: Record<string, BinaryRule> = {
  systemctl: {
    subcommands: [
      "status", "is-active", "is-enabled", "is-failed", "show", "cat",
      "list-units", "list-unit-files", "list-timers", "list-sockets",
      "list-jobs", "get-default",
    ],
    // The listings that take a flag instead of a verb. `--failed` is the one the
    // server check actually runs; `-a`/`--all` and the version banners are the
    // same shape. Everything else with no verb stays parked.
    bareReadFlags: /(^|\s)(--failed|-a|--all|--version|-h|--help)(\s|$|=)/,
  },
  timedatectl: {
    // No sub-verb at all: the bare call prints the clock and the sync state,
    // which is why the server check asks for it. The four `set-*` forms are the
    // only things it writes.
    writeFlags: /(^|\s)(set-time|set-timezone|set-local-rtc|set-ntp)(\s|$|=)/,
  },
  apt: {
    // `apt` writes with a short, well-known set of verbs (`install`, `remove`,
    // `update`, `upgrade`, `autoremove`, `edit-sources`, `download`), so unlike
    // `git` or `docker` a table of its read verbs is not a fiction. `list
    // --upgradable` is the pending-updates line of the server check.
    subcommands: [
      "list", "show", "policy", "search", "madison", "depends", "rdepends",
      "version", "help",
    ],
  },
  journalctl: {
    // Reading logs is the whole reason this binary is here. Trimming, rotating
    // and syncing them are writes wearing a log tool's clothes.
    writeFlags: /(^|\s)(--vacuum\S*|--rotate|--sync|--flush|--relinquish-var|--smart-relinquish-var)(\s|$|=)/,
  },
  git: {
    // Reading history is how she reviews her own changes. Her standing rule
    // promises she may look at the sources and the git history — and until now
    // the gate denied the second half, because `git` was not on any list at all.
    //
    // Only verbs that cannot write: history, diffs, object reads. `branch`,
    // `remote`, `tag`, `config`, `reflog`, `stash` and everything else are NOT
    // here, because each has a write mode under the same name — a table of them
    // would be the fiction the rest of this file warns about. Those stay parked.
    subcommands: [
      "log", "show", "diff", "status", "blame", "shortlog", "rev-list",
      "rev-parse", "describe", "ls-files", "ls-tree", "cat-file",
      "whatchanged", "grep", "version", "help",
    ],
    // Two ways a read verb runs a program of someone else's choosing, both
    // measured before they were closed:
    //
    //   `git grep -O<program>` is --open-files-in-pager, and git runs it with the
    //   file name appended. `git grep -O<sh -c …>` is therefore command
    //   execution that `classify` called "allow" — the whole approval gate
    //   skipped, and with it path-policy, because a shell command was never
    //   subject to it. Verified rather than reasoned: `git grep -Oecho HEAD --
    //   AGENTS.md` printed the file name, so the program really ran.
    //
    //   `-c <name>=<value>` sets a config for one invocation, and some of those
    //   values are program names git executes: `core.fsmonitor`,
    //   `core.pager`, `core.sshCommand`, `core.hooksPath`. `-c` was a value flag
    //   and its value was eaten, so the verb underneath still looked like a
    //   history read. `-C` stays: a directory, not a program.
    writeFlags: /(^|\s)(--output(=|\s|$)|-O\S*|--open-files-in-pager(=|\s|$)|-c(\s|$)|--config-env(=|\s|$))/,
    // `git -C /opt/eva log` is a history read run from another directory; without
    // this the value of `-C` reads as the verb.
    valueFlags: ["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"],
  },
  sort: {
    // `sort -o FILE` writes the sorted output to FILE; without it, sort can only
    // reach stdout, where the redirect check already looks.
    writeFlags: /(^|\s)(-o|--output)(\s|$|=)/,
  },
  date: {
    // `date -s` / `date --set` sets the system clock.
    writeFlags: /(^|\s)(-s|--set)(\s|$|=)/,
  },
  dmesg: {
    // `-c` clears the ring buffer; `-s`, `-n` and the console switches retune it.
    writeFlags: /(^|\s)(-c|--clear|-s|--buffer-size|-n|--console-level|--console-off|--console-on)(\s|$|=)/,
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
  /\b(insert|update|delete|drop|alter|create|replace|vacuum|reindex|attach|detach|pragma|writefile)\b/i;

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
  // Where each redirect points, read here rather than by a regex over the raw
  // command: the same `>` inside quotes is text, and only this loop knows that.
  const redirectTargets: string[] = [];

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
      // Inside double quotes the shell still expands `…` and $(…); only single
      // quotes are literal. Skipping this made `echo "$(rm -rf …)"` read as a
      // plain echo and run unattended.
      if (quote === '"') {
        if (ch === "`") {
          sawSubstitution = true;
        } else if (ch === "$" && command[i + 1] === "(") {
          sawSubstitution = true;
        }
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
      let j = i + 1;
      if (command[j] === ch) j += 1; // >> or <<
      while (command[j] === " " || command[j] === "\t") j += 1;
      let target = "";
      while (j < command.length && !/[\s;|]/.test(command[j])) {
        target += command[j];
        j += 1;
      }
      redirectTargets.push(target);
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
      // `2>&1` duplicates a descriptor, it does not background anything: the `&`
      // sits right after the redirect operator. Read as a job it flagged every
      // `2>&1` as "запуск в фоне", which is the other half of why a plain check
      // line was parked.
      if (command[i - 1] === ">" || command[i - 1] === "<") {
        current += ch;
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
  // A redirect is a write only if it writes somewhere. `/dev/null` is not a file
  // and `>&1` names another descriptor, and both are what every check command
  // ends up with: `apt list --upgradable 2>/dev/null | head -20` was parked over
  // it. Anything with a real target still counts, and the binary rule is not
  // touched — `rm x > /dev/null` is still parked, because `rm` is.
  const writesSomewhere =
    sawRedirect &&
    (redirectTargets.length === 0 ||
      !redirectTargets.every((t) => t === "/dev/null" || /^&\d+$/.test(t)));
  if (writesSomewhere) unsafe.push("перенаправление вывода");
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
function subcommandOf(segment: string, valueFlags?: string[]): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const takesValue = valueFlags && valueFlags.length ? new Set(valueFlags) : null;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  for (let j = i + 1; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (!token) continue;
    if (token.startsWith("-")) {
      // A flag that takes a value swallows the next token, which is not the verb.
      if (takesValue?.has(token)) j += 1;
      continue;
    }
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
 * A path the command line mentions whose content is a secret.
 *
 * The owner's rule for this layer, in his words: she may read everything that
 * makes her smarter and lets her find her own mistakes — the journal, her
 * sources, the reports — and what is closed is the small set whose only purpose
 * is to be secret. So this is not a list of places she is allowed to read (that
 * kind of table would be a fiction, the same way the old blocklist was), and it
 * is not about binaries either: `cat` is a reader and stays one. It is one
 * question asked of every path in the line — would reading this hand the chat a
 * key?
 *
 * The set is the one `path-policy` has always refused to `files` and
 * `send_file`: the install's config and its rotating backups, credentials by
 * name, ssh material, the memory database, and the config's own directory —
 * because `grep -r api_key ~/.eva` names no secret and reads one anyway. Files
 * *inside* that directory stay readable through the `files` tool, which judges
 * them one by one; here a file sitting in the config's directory is parked,
 * which is one tap and not a closed door.
 *
 * Judged by name on purpose. This layer has to stay a function of the command
 * line and of the install, so a symlink in /tmp pointing at the config is not
 * caught, and that is the price. Everything it matches is parked rather than
 * refused, so a false positive costs one tap.
 */
const SECRET_BASENAME =
  /^(\.env(\..+)?|\.netrc|\.htpasswd|\.pgpass|auth\.json|credentials\.json|id_(rsa|dsa|ecdsa|ed25519)|authorized_keys|config\.ya?ml(\.bak.*)?|shadow|gshadow)$/i;
const SECRET_SUFFIX = /(\.(pem|key|p12|pfx)|_key)$/i;

/**
 * Binaries that print the *contents* of the file they are pointed at.
 *
 * Only for these does the config's own directory count as a secret path. `ls`
 * and `find` name files and read none, and the live install uses both (`ls -la
 * ~/.eva` is in its own list of reads that must just work) — parking a listing
 * would be friction with no secret behind it. The list narrows nothing else: a
 * reader added to the allowlist without being added here loses the directory
 * protection, so it is checked when the allowlist grows, not silently trusted.
 */
const CONTENT_READERS = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "nl", "tac", "fold",
  "expand", "sort", "uniq", "cut", "tr", "diff", "cmp", "column", "strings",
]);

function secretPathIn(token: string, policy: PathPolicy, contentsOnly: boolean): string | null {
  const cleaned = token.replace(/^["']+|["']+$/g, "").trim();
  if (!cleaned || cleaned.startsWith("-")) return null;

  const resolved = realPath(expandHome(cleaned));
  const base = path.basename(resolved);
  if (SECRET_BASENAME.test(base)) return base;
  // A suffix is only a file when there is a file: `grep -rn api_key` in her own
  // sources names a word, not a key, and `_key` matched it — searching her
  // sources is exactly the self-check this layer is meant to keep open. A path
  // that does not exist cannot be read, and the exact names above park whether
  // it exists or not.
  if (SECRET_SUFFIX.test(base) && fs.existsSync(resolved)) return base;
  if (/(^|[\\/])\.ssh([\\/]|$)/.test(resolved)) return ".ssh";

  for (const file of policy.deniedFiles) {
    if (resolved === file) return `файл конфигурации (${file})`;
    // The directory itself, and the directory a glob or a search was pointed
    // at: `cat ~/.eva/*` and `grep -r key ~/.eva/` both read the config without
    // ever naming it. Listings are left alone — see CONTENT_READERS.
    if (!contentsOnly) continue;
    const dir = path.dirname(file);
    if (resolved === dir || path.dirname(resolved) === dir) {
      return `каталог конфигурации (${dir})`;
    }
  }
  return null;
}

/**
 * Decide whether a whole command line may run unattended.
 *
 * Every segment must pass. A pipeline is only as safe as its least safe link,
 * and the point of splitting at all is that `ls | xargs rm` contains a writer
 * even though the first half is innocent.
 */
export function classify(command: string, trusted: string[] = [], policy: PathPolicy = defaultPathPolicy()): ShellVerdict {
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

    // Secrets come first, and before the trusted-binary skip on purpose: trust
    // means "its writing modes may run unattended", and the install's keys are
    // not a writing mode. A read-only verb does not unlock them either — `cat`
    // is allowed and the config is still out of reach.
    for (const token of segment.split(/\s+/)) {
      const secret = secretPathIn(token, policy, CONTENT_READERS.has(bin));
      if (secret) return { kind: "gate", why: `в команде путь с секретами: ${secret}` };
    }

    if (trustedBins.has(bin)) continue;

    const rule = RULES[bin];
    if (rule) {
      if (rule.subcommands) {
        const verb = subcommandOf(segment, rule.valueFlags);
        if (!verb) {
          // No verb at all. A binary whose verb is optional may still be reading
          // (`systemctl --failed`); one that always takes a verb is unreadable
          // without it, and that is a gate, not a guess.
          if (!rule.bareReadFlags?.test(segment)) {
            return { kind: "gate", why: `«${bin}» без подкоманды — не знаю, читает она или пишет` };
          }
        } else if (!rule.subcommands.includes(verb)) {
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

/**
 * The command as it should appear on the owner's approval line.
 *
 * Both ends, and a count of what is hidden, because clipping the head alone hid
 * exactly the part that decides the answer: `sh -c "…"` puts the payload at the end,
 * `; rm -rf` sits at the end, and so does the redirect that writes a file he never
 * saw. What he approves has to be what runs — so a long command is not shortened
 * into something else, and when it is shortened at all, it says so.
 */
export function approvalSummary(prefix: string, command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  const max = 700;
  if (flat.length <= max) return `${prefix}: ${flat}`;
  const keep = Math.floor((max - 40) / 2);
  const hidden = flat.length - keep * 2;
  return `${prefix}: ${flat.slice(0, keep)} …(скрыто ${hidden} символов)… ${flat.slice(-keep)}`;
}
