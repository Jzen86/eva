import { exec } from "node:child_process";
import type { Tool, ToolResult } from "./types.js";
import { requireApproval, registerApprovalApplier } from "../pending.js";
import { classify, approvalSummary } from "../shell-policy.js";

const TIMEOUT = 120_000;

export class ShellTool implements Tool {
  name = "shell";
  description =
    "Run a command on the server. Commands that only read run on their own: " +
    "systemctl status, journalctl, ss, ls, cat, tail, df, ps, grep, and a SELECT " +
    "against sqlite3. Everything that can write is NOT executed: the request is " +
    "parked and the owner approves it with /yes. If you get 'Жду подтверждения', " +
    "nothing ran — tell the owner which command and why, and do not retry.";
  parameters = [
    { name: "command", type: "string", description: "The shell command to execute", required: true },
    {
      name: "reason",
      type: "string",
      description: "One line on why this command is needed, shown to the owner when the command needs their yes",
    },
  ];

  private allow: string[];

  constructor(config: { shellTrust?: string[] } = {}) {
    this.allow = config.shellTrust ?? [];
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command;
    if (typeof command !== "string" || !command.trim()) {
      return { success: false, output: "", error: "Missing required parameter: command" };
    }

    // The old check was a four-string blocklist — "rm -rf /", "mkfs", "dd if=",
    // "format" — which named what someone had already thought of and let the
    // rest through. A blocklist can only be as long as the list of things
    // someone has already been burned by; an allowlist is the other way round.
    const verdict = classify(command, this.allow);
    if (verdict.kind === "gate") {
      const approval = requireApproval(params, "shell", {
        summary: approvalSummary("выполнить команду", command),
        reason: typeof params.reason === "string" ? params.reason : "",
        args: { command: command.trim() },
      });
      // Non-null covers both cases: parked for the owner, or refused outright
      // when there is no chat to confirm through — requireApproval says which,
      // and a command that nobody is watching does not run.
      if (approval) return approval;
    }

    return run(command);
  }
}

async function run(command: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    exec(command, { timeout: TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, output: stderr || stdout || "", error: err.message });
      } else {
        resolve({ success: true, output: stdout, error: stderr || undefined });
      }
    });
  });
}

// How a parked command runs once the owner has said yes.
registerApprovalApplier("shell", async (args) => {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return { success: false, output: "", error: "empty command" };
  return run(command);
});
