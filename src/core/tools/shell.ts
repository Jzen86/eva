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
    "nothing ran — tell the owner which command and why, and do not retry. " +
    "A non-zero exit is an answer, not a breakdown: `grep` with no match exits 1, " +
    "`systemctl status` on an inactive unit exits 3, and the code comes back with " +
    "the output — read it, do not take it for the platform refusing you. When you " +
    "run several checks, join them with `;` rather than `&&`: with `&&` the first " +
    "empty answer (a unit that is off on purpose) stops every step after it.";
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

async function run(command: string, nonZeroIsFailure = false): Promise<ToolResult> {
  return new Promise((resolve) => {
    exec(command, { timeout: TIMEOUT }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ success: true, output: stdout, error: stderr || undefined });
        return;
      }
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
      const body = (stdout || stderr || "").trimEnd();
      // No numeric code means the command never ran — a spawn failure or the
      // timeout killing it. That is a broken tool.
      //
      // A non-zero code is an answer for an automatic read: `grep` with no match
      // exits 1, `systemctl status` on an inactive unit exits 3, `journalctl |
      // grep` with nothing to find exits 1. Reporting those as "Command failed"
      // is what made a normal read look like a platform that refuses the
      // terminal — the owner was told the environment cuts requests, over a
      // service that is off on purpose. For a command the owner approved with
      // /yes it is the opposite: they said it should work, so a non-zero code is
      // a failure and the caller is told so.
      if (code === null || nonZeroIsFailure) {
        resolve({ success: false, output: body, error: err.message });
        return;
      }
      resolve({
        success: true,
        output: `${body ? `${body}\n` : ""}(exit ${code})`,
        error: stderr || undefined,
      });
    });
  });
}

// How a parked command runs once the owner has said yes. A non-zero code here is
// a failure, not an answer: they said it should work, so if it does not, they are
// told — the opposite of the automatic-read path above.
registerApprovalApplier("shell", async (args) => {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return { success: false, output: "", error: "empty command" };
  return run(command, true);
});
