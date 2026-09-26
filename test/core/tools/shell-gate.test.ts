import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellTool } from "../../../src/core/tools/shell.js";
import { SshTool } from "../../../src/core/tools/ssh.js";
import { peek, discard, applyPending } from "../../../src/core/pending.js";

/**
 * The gate, end to end.
 *
 * The allowlist itself is tested in shell-policy.test.ts. What matters here is
 * the other half: that a write really does stop, that what stopped is visible
 * to the owner, and that saying yes is what releases it. A gate that ran the
 * command while reporting that it did not would be worse than no gate.
 *
 * The assertions are written to hold on a machine where the commands may not
 * exist. "Nothing ran" is proved by a file that must be absent, or by output
 * that must be absent — never by the shape of a message, which would pass just
 * as well if the write had happened first.
 */

const OWNER = "42";

let scratch: string;
const file = (name: string): string => join(scratch, name);

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eva-gate-"));
  discard(OWNER);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  discard(OWNER);
});

describe("ShellTool", () => {
  it("runs a read without asking", async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: "echo hello", _userId: OWNER });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("hello");
    expect(peek(OWNER)).toBeUndefined();
  });

  it("does not run a write, and the file it would have made is not there", async () => {
    const tool = new ShellTool();
    const target = file("written.txt");
    const result = await tool.execute({ command: `echo pwned > ${target}`, _userId: OWNER });

    expect(result.output).toContain("Жду подтверждения");
    expect(result.output).toContain("НЕ ВЫПОЛНЕНО");
    // The write is the assertion. The message would read the same either way.
    expect(existsSync(target)).toBe(false);
    expect(peek(OWNER)?.action?.name).toBe("shell");
  });

  it("parks a command for its writing verbs, not only its redirects", async () => {
    const tool = new ShellTool();
    for (const cmd of ["systemctl restart eva", "npm install left-pad", "git push origin main"]) {
      discard(OWNER);
      const result = await tool.execute({ command: cmd, _userId: OWNER });
      expect(result.output, cmd).toContain("Жду подтверждения");
      expect(peek(OWNER)?.action?.args).toEqual({ command: cmd });
    }
  });

  it("parks the exact command and the model's reason, for the approval line", async () => {
    const tool = new ShellTool();
    await tool.execute({
      command: "npm install left-pad",
      reason: "нужен для парсинга",
      _userId: OWNER,
    });
    const parked = peek(OWNER);
    expect(parked?.action?.name).toBe("shell");
    expect(parked?.action?.args).toEqual({ command: "npm install left-pad" });
    expect(parked?.summary).toContain("npm install left-pad");
    // The model's own words reach the owner, which is the difference between
    // "почему она опять что-то хочет" and "да, именно это я и просил".
    expect(parked?.reason).toBe("нужен для парсинга");
  });

  it("refuses outright when there is no chat to confirm through", async () => {
    // A call with no owner id is the model talking to itself, or a scheduled
    // job nobody is watching. There is nobody to tap /yes, so it must not run.
    const tool = new ShellTool();
    const target = file("no-chat.txt");
    const result = await tool.execute({ command: `echo pwned > ${target}` });

    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("без чата");
    expect(result.error?.toLowerCase()).toContain("не выполнено");
    expect(existsSync(target)).toBe(false);
  });

  it("still needs the command", async () => {
    const tool = new ShellTool();
    expect((await tool.execute({ command: "   ", _userId: OWNER })).success).toBe(false);
  });

  it("runs a binary the owner put in tools.shell_trust, and only that", async () => {
    // `node -e` writes nothing anywhere and is on the default list nowhere, so
    // the difference between the two tools is the knob and nothing else.
    const command = `node -e "console.log('ran-it')"`;
    const trusting = new ShellTool({ shellTrust: ["node"] });
    const allowed = await trusting.execute({ command, _userId: OWNER });
    expect(allowed.success).toBe(true);
    expect(allowed.output.trim()).toBe("ran-it");

    const plain = new ShellTool();
    const parked = await plain.execute({ command, _userId: OWNER });
    // The ⏸ only ever appears on a parked proposal, so it separates "asked"
    // from "ran" without depending on the command's own text.
    expect(parked.output.startsWith("⏸")).toBe(true);
    expect(parked.output).toContain("Жду подтверждения");
  });

  it("tells the model not to retry, or it will ask again in a loop", async () => {
    const tool = new ShellTool();
    // Twice, because the instruction has to be in both places: in the parked
    // output the model reads now, and in the description it read beforehand.
    const result = await tool.execute({ command: "systemctl restart eva", _userId: OWNER });
    expect(result.output).toContain("/yes");
    expect(result.output.toLowerCase()).toContain("не повторяй");
    expect(tool.description.toLowerCase()).toContain("do not retry");
  });
});

describe("the /yes path", () => {
  it("runs the parked command, and the thing it was asked to do is done", async () => {
    const tool = new ShellTool();
    const target = file("approved.txt");
    const parked = await tool.execute({ command: `echo approved > ${target}`, _userId: OWNER });
    expect(parked.output).toContain("Жду подтверждения");
    expect(existsSync(target)).toBe(false);

    const applied = await applyPending(OWNER);
    expect(applied.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8").trim()).toBe("approved");
    // A proposal must not survive being used, or the next /yes re-runs it.
    expect(peek(OWNER)).toBeUndefined();
  });

  it("says there is nothing to confirm when nothing was proposed", async () => {
    const applied = await applyPending(OWNER);
    expect(applied.ok).toBe(false);
    expect(applied.message).toContain("Нечего подтверждать");
  });

  it("reports a failure rather than claiming success", async () => {
    const tool = new ShellTool();
    await tool.execute({ command: "this-binary-does-not-exist-eva", _userId: OWNER });
    const applied = await applyPending(OWNER);
    expect(applied.ok).toBe(false);
    expect(applied.message).toContain("Не получилось");
  });
});

describe("SshTool", () => {
  it("refuses a host that is trying to be a command", async () => {
    const tool = new SshTool();
    for (const bad of ["example.com; rm -rf /", "h && id", "h$(id)"]) {
      const result = await tool.execute({ host: bad, command: "ls", _userId: OWNER });
      expect(result.success, bad).toBe(false);
      expect(result.error, bad).toBe("invalid_param");
    }
    expect(peek(OWNER)).toBeUndefined();
  });

  it("parks a remote command that smuggles something in, instead of sending it", async () => {
    const tool = new SshTool();
    for (const bad of ["$(whoami)", "`id`", "a|b", "a&&b"]) {
      discard(OWNER);
      const result = await tool.execute({ host: "127.0.0.1", command: bad, _userId: OWNER });
      expect(result.output, bad).toContain("Жду подтверждения");
      expect(peek(OWNER)?.action?.args).toMatchObject({ command: bad });
    }
  });

  it("parks a remote write and names the host on the approval line", async () => {
    const tool = new SshTool();
    const result = await tool.execute({
      host: "backup.example.com",
      command: "systemctl restart nginx",
      reason: "конфиг менял",
      _userId: OWNER,
    });
    expect(result.output).toContain("Жду подтверждения");
    const parked = peek(OWNER);
    // Which host matters as much as which command, or the owner approves the
    // wrong machine's restart.
    expect(parked?.summary).toContain("backup.example.com");
    expect(parked?.summary).toContain("systemctl restart nginx");
    expect(parked?.action?.args).toMatchObject({
      host: "backup.example.com",
      command: "systemctl restart nginx",
      port: 22,
    });
  });

  it("needs host and command", async () => {
    const tool = new SshTool();
    expect((await tool.execute({ command: "ls", _userId: OWNER })).error).toBe("missing_param");
    expect((await tool.execute({ host: "h", _userId: OWNER })).error).toBe("missing_param");
  });

  it("keeps a read-only remote command out of the gate", async () => {
    // Port 1 refuses instantly, so this proves the command was not parked
    // without a network and without waiting for a host that does not exist.
    const tool = new SshTool();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await tool.execute({ host: "127.0.0.1", port: 1, command: "journalctl -n 5", _userId: OWNER });
    } finally {
      quiet.mockRestore();
    }
    expect(peek(OWNER)).toBeUndefined();
  });
});
