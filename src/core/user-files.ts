/**
 * The owner's file vault: one path, one reader.
 *
 * Guides and tables the owner drops on the server live in a `files/` directory
 * beside the config. Like the reference photo, the path is derived from the
 * config's directory, never from a hardcoded home — `EVA_CONFIG_PATH` moves the
 * whole install, and a vault that init created in one place while the running
 * bot listed another is a vault that exists and is never seen.
 *
 * The vault's contents stay out of this module on purpose: they are read on
 * demand through the `files` tool, page by page. The prompt only ever says that
 * the place exists and where it is — a standing couple of lines, not a file
 * list rebuilt every turn.
 */

import path from "node:path";
import { getConfigPath } from "./config.js";

/**
 * Where the vault lives: `<config-dir>/files`.
 *
 * Inside the default path-policy roots (the config directory is a root), so
 * listing and reading it never parks for a /yes — the same openness as `cat`.
 */
export function userFilesPath(configPath?: string): string {
  return path.join(path.dirname(configPath ?? getConfigPath()), "files");
}
