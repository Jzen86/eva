/**
 * The mechanics of the tool, without the gate.
 *
 * Whether a given command runs is shell-gate.test.ts's question and
 * shell-policy.test.ts's. What is left here is the wrapper: it takes a string,
 * runs it, and reports what happened without dressing it up.
 */

import { describe, it, expect } from "vitest";
import { ShellTool } from "../../../src/core/tools/shell.js";

describe("ShellTool", () => {
  const tool = new ShellTool();

  it("executes a read", async () => {
    const result = await tool.execute({ command: "echo hello" });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("hello");
  });

  it("reports a non-zero exit as an answer, not a broken tool", async () => {
    // `grep` with no match exits 1, `systemctl status` on an inactive unit exits
    // 3. Both are normal replies to a read, and calling them "Command failed" is
    // what made the live platform look like it was refusing the terminal.
    const result = await tool.execute({ command: "type no_such_file_xyz" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("exit 1");
  });

  it("returns error for missing command", async () => {
    expect((await tool.execute({})).error).toContain("Missing");
    expect((await tool.execute({ command: "   " })).error).toContain("Missing");
  });

  it("does not run a write — and says why, in the reason a write cannot proceed", async () => {
    // The old test here asserted the word "blocked" and passed while the
    // command was never considered, because a four-string blocklist had said so.
    // What matters now is only that the write did not happen.
    const result = await tool.execute({ command: "rm -rf /" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("подтвердить нечем");
  });
});
