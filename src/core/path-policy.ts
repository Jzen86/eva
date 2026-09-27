/**
 * Where `files` and `send_file` may reach.
 *
 * Both tools took whatever absolute path the model named: `files` could write
 * anywhere on the box, and `send_file` would hand any file to Telegram. That is
 * a strictly more powerful primitive than `shell`, and `shell` parks every
 * write for /yes — so the tools that could do the most asked for nothing.
 *
 * The rule here mirrors shell-policy: reading is as open as `cat` (which the
 * allowlist already permits), minus a small set of paths whose whole purpose is
 * to be secret; writing and sending are confined to configured roots, and a
 * write outside them parks for the owner.
 *
 * Paths are judged on their real path, not the string, so `root/../../etc` and
 * a symlink pointing out of the root are both caught: the deepest existing
 * ancestor is resolved and the tail re-attached.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath } from "./config.js";

export type PathVerdict =
  | { kind: "allow"; path: string }
  | { kind: "gate"; path: string; why: string }
  | { kind: "deny"; path: string; why: string };

export interface PathPolicy {
  roots: string[];
  /** Files that are secrets by location (the config, by default). */
  deniedFiles: string[];
}

/** Directories nothing may touch, whoever asks. */
const DENIED_PREFIXES = ["/proc", "/sys", "/dev", "/boot", "/etc", "/run", "/var/run"];

/** Basenames that are credentials wherever they live. */
const DENIED_BASENAMES = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "authorized_keys",
  ".htpasswd",
  ".netrc",
]);

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The real path, resolving symlinks on the deepest ancestor that exists.
 *
 * A write target usually does not exist yet, so `realpathSync` on the whole
 * path would throw. Resolving the existing ancestor and re-attaching the tail
 * is what stops `~/.eva/link -> /etc` from being read as "inside ~/.eva".
 */
export function realPath(target: string): string {
  const abs = path.resolve(target);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** True when `child` is `root` or lives under it (boundary-aware, so /ab is not /a). */
function inside(child: string, root: string): boolean {
  if (child === root) return true;
  const sep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(sep);
}

/**
 * The policy an install gets without saying anything.
 *
 * Roots are the config directory and temp: the places the bot writes its own
 * files. `tools.files_roots`, when set, replaces that list. The config file
 * itself is always denied, because the install's keys live in it.
 */
export function defaultPathPolicy(configPath?: string, configuredRoots?: string[]): PathPolicy {
  const cfg = configPath ?? getConfigPath();
  const roots = (configuredRoots ?? []).filter((r) => typeof r === "string" && r.trim() !== "");
  return {
    roots: roots.length ? roots.map(expandHome) : [path.dirname(cfg), os.tmpdir()],
    deniedFiles: [realPath(cfg)],
  };
}

/** Is the path reachable, must ask, or never? */
export function classifyPath(raw: string, policy: PathPolicy): PathVerdict {
  const expanded = expandHome(String(raw ?? "").trim());
  if (!expanded) return { kind: "deny", path: "", why: "пустой путь" };
  const resolved = realPath(expanded);

  for (const prefix of DENIED_PREFIXES) {
    if (inside(resolved, prefix)) {
      return { kind: "deny", path: resolved, why: `системный путь ${prefix}` };
    }
  }
  if (DENIED_BASENAMES.has(path.basename(resolved).toLowerCase())) {
    return { kind: "deny", path: resolved, why: "похоже на файл с секретами" };
  }
  if (/\.db(-wal|-shm)?$/i.test(resolved)) {
    return { kind: "deny", path: resolved, why: "база памяти, а не файл для чтения или отправки" };
  }
  for (const file of policy.deniedFiles) {
    if (resolved === file) {
      return { kind: "deny", path: resolved, why: "файл конфигурации — в нём секреты" };
    }
  }

  const roots = policy.roots.map((r) => realPath(expandHome(r)));
  if (roots.some((root) => inside(resolved, root))) {
    return { kind: "allow", path: resolved };
  }
  return { kind: "gate", path: resolved, why: `вне разрешённых каталогов: ${roots.join(", ")}` };
}
