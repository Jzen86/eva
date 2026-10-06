import { readFile, writeFile, readdir } from "node:fs/promises";
import readXlsxFile from "read-excel-file/node";
import type { Tool, ToolResult } from "./types.js";
import { requireApproval, registerApprovalApplier } from "../pending.js";
import { classifyPath, defaultPathPolicy, type PathPolicy } from "../path-policy.js";

/**
 * Read, write and list files, under a path policy.
 *
 * This used to run `readFile`/`writeFile` on whatever absolute path the model
 * named, with no approval and no jail — a strictly more powerful primitive than
 * `shell`, whose whole design is that a wrong guess costs one tap. Reading is
 * now as open as `cat` (which the allowlist permits) minus secrets, and writing
 * is confined to the configured roots; a write outside them parks for /yes.
 *
 * Reads are paged. A guide longer than what the engine will show of a tool
 * result used to die in the middle: the model saw the head and never learned
 * there was a tail. The pager cuts by characters, keeps lines whole, and ends
 * every short page with the exact `offset` that continues the file.
 *
 * `.xlsx` flattens to text right here — one `### Лист: <имя>` block per sheet,
 * cells joined with " | " — so a spreadsheet the owner dropped as a table reads
 * like a file, and the pager works the same on both.
 */
export class FilesTool implements Tool {
  name = "files";
  description =
    "Read, write, or list files. Reading and listing work anywhere except " +
    "secrets, system paths and the memory database. Writing is limited to the " +
    "configured file roots (the config directory and temp by default); a write " +
    "outside them does not run, and waits for the owner's /yes. " +
    "Reading is paged: pass offset (0-based line) to continue where the last " +
    "page stopped; .xlsx files are returned as text, one block per sheet.";
  parameters = [
    { name: "action", type: "string", description: "Action to perform: read, write, or list", required: true },
    { name: "path", type: "string", description: "File or directory path", required: true },
    { name: "content", type: "string", description: "Content to write (required for write action)" },
    {
      name: "offset",
      type: "number",
      description: "Read: 0-based line to start from, for paging through big files. Default 0.",
    },
    {
      name: "limit",
      type: "number",
      description: "Read: page size in characters (lines are kept whole). Default 6000, cap 20000.",
    },
    {
      name: "reason",
      type: "string",
      description: "One line on why this write is needed, shown to the owner when it needs their yes",
    },
  ];

  private policy: PathPolicy;

  constructor(opts: { policy?: PathPolicy } = {}) {
    this.policy = opts.policy ?? defaultPathPolicy();
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string | undefined;
    const rawPath = params.path as string | undefined;

    if (!action || !rawPath) {
      return { success: false, output: "", error: "Missing required parameters: action and path" };
    }
    if (action !== "read" && action !== "write" && action !== "list") {
      return { success: false, output: "", error: `Unknown action: ${action}. Use read, write, or list.` };
    }

    const verdict = classifyPath(rawPath, this.policy);
    if (verdict.kind === "deny") {
      return { success: false, output: "", error: `Путь запрещён: ${verdict.why} (${verdict.path})` };
    }
    // Reads past the roots are as allowed as `cat`; only a write past them is
    // the thing the owner has to release.
    if (verdict.kind === "gate" && action === "write") {
      const approval = requireApproval(params, "files", {
        summary: `записать файл ${verdict.path}`,
        reason: typeof params.reason === "string" ? params.reason : "",
        args: { action, path: verdict.path, content: params.content },
      });
      if (approval) return approval;
    }

    return runAction(action, verdict.path, params);
  }
}

/**
 * Default read page, in characters.
 *
 * The engine cuts tool output at 8000 chars; a page that overruns it would
 * lose its own footer — the one line that says how to continue. 6000 leaves
 * room for the footer and for the model's attention.
 */
const READ_PAGE_CHARS = 6000;
const READ_PAGE_CHARS_MAX = 20000;

/** A page of lines, cut by characters with lines kept whole. */
interface Page {
  text: string;
  /** 0-based first line shown. */
  from: number;
  /** One past the last line shown. */
  to: number;
  /** Lines in the whole text. */
  total: number;
  /** Whether lines remain past this page. */
  hasMore: boolean;
}

function pageByChars(text: string, offset: number, maxChars: number): Page {
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(0, Math.min(offset, total));
  let chars = 0;
  let to = from;
  // A single line longer than the budget still ships whole: cutting it here
  // would only move the engine's cut one step earlier, and a row that big is
  // usually exactly the row being asked for.
  while (to < total && (chars === 0 || chars + lines[to].length + 1 <= maxChars)) {
    chars += lines[to].length + 1;
    to++;
  }
  return { text: lines.slice(from, to).join("\n"), from, to, total, hasMore: to < total };
}

/** One cell of a spreadsheet, in words. Dates go ISO, empties vanish. */
function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell);
}

/**
 * A spreadsheet, in the words she reads files with.
 *
 * All sheets in file order, each under its own heading, so a multi-sheet guide
 * keeps its shape. Rows are " | "-joined — it reads as a table without being
 * one syntactically, so no quoting hazard survives to the model. Empty rows
 * and cells are dropped: a sheet's whitespace is not its content.
 */
async function readXlsxAsText(path: string): Promise<string> {
  const buffer = await readFile(path);
  const sheets = await readXlsxFile(buffer);
  const blocks = sheets.map(({ sheet, data }) => {
    const lines = data
      .map((row) => row.map(cellToText).filter((c) => c !== "").join(" | "))
      .filter((line) => line.trim() !== "");
    return `### Лист: ${sheet}\n${lines.length > 0 ? lines.join("\n") : "(пусто)"}`;
  });
  return blocks.join("\n");
}

function readNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

async function runAction(action: string, path: string, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (action === "read") {
      const raw = path.toLowerCase().endsWith(".xlsx") ? await readXlsxAsText(path) : await readFile(path, "utf-8");
      const offset = Math.max(0, Math.floor(readNumber(params.offset) ?? 0));
      const limit = Math.min(Math.max(1, Math.floor(readNumber(params.limit) ?? READ_PAGE_CHARS)), READ_PAGE_CHARS_MAX);
      const page = pageByChars(raw, offset, limit);
      if (page.from >= page.total && offset > 0) {
        return { success: true, output: `(в файле ${page.total} строк; offset=${offset} — за краем, вернулась пустая страница)` };
      }
      let output = page.text;
      if (page.hasMore) {
        output +=
          `\n\n(показаны строки ${page.from + 1}–${page.to} из ${page.total}. ` +
          `Продолжай: files action="read" path="${path}" offset=${page.to})`;
      } else if (page.from > 0) {
        output += `\n\n(конец файла: строки ${page.from + 1}–${page.total} из ${page.total})`;
      }
      return { success: true, output };
    }
    if (action === "list") {
      return { success: true, output: (await readdir(path)).join("\n") };
    }
    const content = params.content;
    if (content === undefined || typeof content !== "string") {
      return { success: false, output: "", error: "Missing required parameter: content (for write action)" };
    }
    await writeFile(path, content, "utf-8");
    return { success: true, output: `Written to ${path}` };
  } catch (err) {
    return { success: false, output: "", error: (err as Error).message };
  }
}

// How a parked write runs once the owner has said yes. Past the gate, the
// policy has already done its job, so this performs the write directly.
registerApprovalApplier("files", async (args) => {
  return runAction(String(args.action ?? ""), String(args.path ?? ""), args as Record<string, unknown>);
});
