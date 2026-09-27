import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { classifyPath, defaultPathPolicy, expandHome, type PathPolicy } from "../path-policy.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (Telegram bot limit)

/**
 * Send a file to the owner's chat, from inside the configured roots only.
 *
 * It used to accept any absolute path, which made it the exfiltration primitive
 * for everything the bot can reach — the config, keys, the memory database.
 * Unlike `files write` this cannot be gated with /yes, because an approved
 * action is re-run as text and the media would not be delivered; so anything
 * outside the roots and anything secret is refused outright.
 */
export class SendFileTool implements Tool {
  name = "send_file";
  description =
    "Send a file from the server to the user in chat. Use after downloading or " +
    "creating a file. Only files inside the configured file roots can be sent.";
  parameters = [
    { name: "path", type: "string", description: "Absolute path to the file on server", required: true },
    { name: "caption", type: "string", description: "Optional caption/message to send with the file", required: false },
  ];

  private policy: PathPolicy;

  constructor(opts: { policy?: PathPolicy } = {}) {
    this.policy = opts.policy ?? defaultPathPolicy();
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(params.path ?? "").trim();
    if (!raw) {
      return { success: false, output: "Missing required parameter: path" };
    }

    const expanded = expandHome(raw);
    if (!path.isAbsolute(expanded)) {
      return { success: false, output: "Path must be absolute" };
    }

    const verdict = classifyPath(expanded, this.policy);
    if (verdict.kind !== "allow") {
      return {
        success: false,
        output: "",
        error: `Не могу отправить этот файл: ${verdict.why}. Разрешённые каталоги: ${this.policy.roots.join(", ")}.`,
      };
    }

    const filePath = verdict.path;
    if (!fs.existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { success: false, output: "Path is not a file" };
    }

    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      return { success: false, output: `File too large: ${sizeMB} MB (max 50 MB for Telegram)` };
    }

    const caption = typeof params.caption === "string" ? params.caption.trim() : undefined;
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

    return {
      success: true,
      output: caption || `File sent: ${path.basename(filePath)} (${sizeMB} MB)`,
      mediaPath: filePath,
    };
  }
}
