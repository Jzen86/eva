/**
 * Test-only stand-in for better-sqlite3, backed by Node's built-in
 * `node:sqlite`. Not shipped — vitest aliases the module name to this file.
 *
 * better-sqlite3 is a native addon, so on a machine without a C++ toolchain it
 * fails to load and every test touching the database dies before it runs. Node
 * 22.5+ ships SQLite in the core, which is enough for the whole surface this
 * project uses: exec, prepare, run/get/all, close.
 *
 * Two things are missing from node:sqlite and added here: `pragma()` and
 * `transaction()`.
 */
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

class Statement {
  constructor(private readonly stmt: ReturnType<DatabaseSync["prepare"]>) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt.run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(...params: unknown[]): unknown {
    return this.stmt.get(...(params as never[]));
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...(params as never[])) as unknown[];
  }
}

class Shim {
  private readonly inner: DatabaseSync;
  readonly open = true;
  readonly memory = false;
  readonly name = ":memory:";

  constructor(filename: string, _options?: unknown) {
    this.inner = new DatabaseSync(filename === ":memory:" ? ":memory:" : filename);
  }

  exec(sql: string): this {
    this.inner.exec(sql);
    return this;
  }

  prepare(sql: string): Statement {
    return new Statement(this.inner.prepare(sql));
  }

  /** better-sqlite3: db.pragma("table_info(x)") returns rows, db.pragma("journal_mode = WAL") applies it. */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const text = source.trim();
    // Assignment form: "journal_mode = WAL", "foreign_keys = ON"
    const assign = text.match(/^(\w[\w\s]*?)\s*=\s*(.+)$/);
    if (assign) {
      const result = this.inner.prepare(`PRAGMA ${assign[1]!.trim()}`).all();
      void assign;
      void options;
      return result;
    }
    return this.inner.prepare(`PRAGMA ${text}`).all();
  }

  /** better-sqlite3 runs the callback immediately and returns a callable wrapper. */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const self = this;
    const wrapped = function (this: unknown, ...args: never[]) {
      self.exec("BEGIN");
      try {
        const out = fn(...args);
        self.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          self.exec("ROLLBACK");
        } catch {
          /* the transaction was already unwound */
        }
        throw err;
      }
    };
    return wrapped as unknown as T;
  }

  close(): void {
    this.inner.close();
  }
}

export type Database = { Database: new (filename: string, options?: unknown) => Shim };
const DatabaseCtor = Shim as unknown as Database["Database"];
export default DatabaseCtor;
export { Shim as SqliteShim };
export type { Row };
