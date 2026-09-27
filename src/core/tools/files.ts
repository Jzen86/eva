import { readFile, writeFile, readdir } from "node:fs/promises";
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
 */
export class FilesTool implements Tool {
  name = "files";
  description =
    "Read, write, or list files. Reading and listing work anywhere except " +
    "secrets, system paths and the memory database. Writing is limited to the " +
    "configured file roots (the config directory and temp by default); a write " +
    "outside them does not run, and waits for the owner's /yes.";
  parameters = [
    { name: "action", type: "string", description: "Action to perform: read, write, or list", required: true },
    { name: "path", type: "string", description: "File or directory path", required: true },
    { name: "content", type: "string", description: "Content to write (required for write action)" },
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

    return runAction(action, verdict.path, params.content);
  }
}

async function runAction(action: string, path: string, content: unknown): Promise<ToolResult> {
  try {
    if (action === "read") {
      return { success: true, output: await readFile(path, "utf-8") };
    }
    if (action === "list") {
      return { success: true, output: (await readdir(path)).join("\n") };
    }
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
  return runAction(String(args.action ?? ""), String(args.path ?? ""), args.content);
});
