import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.js";
import { requireApproval, registerApprovalApplier } from "../pending.js";
import { classify, approvalSummary } from "../shell-policy.js";

const execAsync = promisify(exec);

/** Maximum time (ms) to wait for an SSH command to complete. */
const SSH_TIMEOUT = 30_000;

/** Characters allowed in a host, user or key path. */
const SAFE_FIELD = /^[a-zA-Z0-9._@:\/~-]+$/;

export interface SshToolConfig {
  shellTrust?: string[];
}

export class SshTool implements Tool {
  name = "ssh";
  description =
    "Run a command on a remote host over SSH. Commands that only read run on " +
    "their own — systemctl status, journalctl, ls, tail, df, ps, grep. Anything " +
    "that can write is parked for the owner to approve with /yes. If you get " +
    "'Жду подтверждения', nothing ran: tell the owner the host and the command, " +
    "and do not retry.";
  parameters = [
    { name: "host", type: "string", description: "Remote hostname or IP", required: true },
    { name: "command", type: "string", description: "Command to run on the remote host", required: true },
    { name: "username", type: "string", description: "SSH username (defaults to current user)" },
    { name: "key", type: "string", description: "Path to SSH private key file" },
    { name: "port", type: "number", description: "SSH port (default 22)" },
    {
      name: "reason",
      type: "string",
      description: "One line on why this command is needed, shown to the owner when the command needs their yes",
    },
  ];

  private allow: string[];

  constructor(config: SshToolConfig = {}) {
    this.allow = config.shellTrust ?? [];
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const host = params.host;
    if (typeof host !== "string" || !host.trim()) {
      return { success: false, output: "Missing required parameter: host", error: "missing_param" };
    }

    const command = params.command;
    if (typeof command !== "string" || !command.trim()) {
      return { success: false, output: "Missing required parameter: command", error: "missing_param" };
    }

    // The host, user and key path go into a command line, so they get a
    // character allowlist rather than escaping. A hostname with a semicolon in
    // it is not a hostname.
    if (!SAFE_FIELD.test(host.trim())) {
      return { success: false, output: `Invalid host: ${host}`, error: "invalid_param" };
    }

    const username =
      typeof params.username === "string" && params.username.trim()
        ? params.username.trim()
        : undefined;

    if (username && !SAFE_FIELD.test(username)) {
      return { success: false, output: `Invalid username: ${username}`, error: "invalid_param" };
    }

    const keyPath =
      typeof params.key === "string" && params.key.trim()
        ? params.key.trim()
        : undefined;

    if (keyPath && !SAFE_FIELD.test(keyPath)) {
      return { success: false, output: `Invalid key path: ${keyPath}`, error: "invalid_param" };
    }

    const port =
      typeof params.port === "number" && Number.isInteger(params.port)
        ? params.port
        : 22;

    // A read-only command on a remote host is still a read-only command, so the
    // same allowlist applies. Enabling the tool in `tools:` is the owner saying
    // the bot may reach the host at all; it is not a blank cheque for whatever
    // runs there.
    const verdict = classify(command, this.allow);
    if (verdict.kind === "gate") {
      const approval = requireApproval(params, "ssh", {
        summary: approvalSummary(`выполнить на ${host.trim()}`, command),
        reason: typeof params.reason === "string" ? params.reason : "",
        args: {
          command: command.trim(),
          host: host.trim(),
          ...(username ? { username } : {}),
          ...(keyPath ? { key: keyPath } : {}),
          port,
        },
      });
      if (approval) return approval;
    }

    return run({
      command,
      host: host.trim(),
      username,
      keyPath,
      port,
    });
  }
}

interface RunArgs {
  command: string;
  host: string;
  username?: string;
  keyPath?: string;
  port: number;
}

async function run(args: RunArgs): Promise<ToolResult> {
  const sshArgs: string[] = [
    "ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
  ];

  if (args.keyPath) sshArgs.push("-i", args.keyPath);
  if (args.port !== 22) sshArgs.push("-p", String(args.port));

  const target = args.username ? `${args.username}@${args.host}` : args.host;
  sshArgs.push(target);

  // The remote command is passed as a single string argument; single quotes are
  // escaped the only way a shell can survive inside a single-quoted string.
  const escapedCommand = args.command.replace(/'/g, "'\\''");
  sshArgs.push(`'${escapedCommand}'`);

  try {
    const { stdout, stderr } = await execAsync(sshArgs.join(" "), {
      timeout: SSH_TIMEOUT,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { success: true, output: output || "(no output)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `SSH command failed: ${msg}`,
      error: "ssh_failed",
    };
  }
}

// How a parked remote command runs once the owner has said yes.
registerApprovalApplier("ssh", async (raw) => {
  const host = typeof raw.host === "string" ? raw.host : "";
  const command = typeof raw.command === "string" ? raw.command : "";
  if (!host || !command) {
    return { success: false, output: "", error: "empty host or command" };
  }
  return run({
    command,
    host,
    username: typeof raw.username === "string" ? raw.username : undefined,
    keyPath: typeof raw.key === "string" ? raw.key : undefined,
    port: typeof raw.port === "number" ? raw.port : 22,
  });
});
