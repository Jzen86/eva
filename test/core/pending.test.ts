import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import {
  propose,
  peek,
  discard,
  applyPending,
  requireApproval,
  registerApprovalApplier,
} from "../../src/core/pending";
import { loadConfig } from "../../src/core/config";
import { npmInstallTool } from "../../src/core/tools/npm-install";

/**
 * The confirmation that used to be only a flag.
 *
 * `requiresConfirmation` was set by three tools and read by nothing, and
 * npm-install told the model in its own description that untrusted packages
 * "require explicit approval". None of it was true. These cover the mechanism
 * that replaced it: nothing takes effect until the owner says yes, from a
 * channel of their own, and the model is told plainly that it has not
 * happened.
 */
let tmpDir: string;
let prevPath: string | undefined;

const OWNER = "owner-1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-pending-"));
  prevPath = process.env.EVA_CONFIG_PATH;
  process.env.EVA_CONFIG_PATH = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(
    path.join(tmpDir, "config.yaml"),
    stringify({ agent: { name: "Eva" }, telegram: { token: "t" } }),
  );
  discard(OWNER);
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.EVA_CONFIG_PATH;
  else process.env.EVA_CONFIG_PATH = prevPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pending approvals", () => {
  it("has nothing to apply when nothing was proposed", async () => {
    const res = await applyPending(OWNER);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Нечего подтверждать/);
  });

  it("keeps one proposal per owner, newest wins", () => {
    propose(OWNER, { kind: "config_set", key: "agent.name", value: "A", summary: "a", reason: "" });
    propose(OWNER, { kind: "config_set", key: "agent.name", value: "B", summary: "b", reason: "" });
    expect(peek(OWNER)?.value).toBe("B");
  });

  it("peek does not consume", () => {
    propose(OWNER, { kind: "config_set", key: "agent.name", value: "A", summary: "a", reason: "" });
    peek(OWNER);
    peek(OWNER);
    expect(peek(OWNER)).toBeDefined();
  });

  it("discard returns what it dropped and leaves nothing", async () => {
    propose(OWNER, { kind: "config_set", key: "agent.name", value: "A", summary: "a", reason: "" });
    expect(discard(OWNER)?.value).toBe("A");
    expect(peek(OWNER)).toBeUndefined();
    expect(discard(OWNER)).toBeUndefined();
  });

  it("refuses to gate a call with no chat to approve through", () => {
    // No chat means no /yes can arrive and the action would sit forever.
    const res = requireApproval({}, "some_tool", { summary: "x" });
    expect(res).not.toBeNull();
    expect(res!.success).toBe(false);
    expect(res!.error).toMatch(/подтверждени/i);
  });

  it("lets a call through when nothing needs gating", () => {
    expect(requireApproval({ _userId: OWNER }, "some_tool", { summary: "x" })).not.toBeNull();
    expect(peek(OWNER)?.summary).toBe("x");
  });

  it("tells the model the action has NOT happened", () => {
    const res = requireApproval({ _userId: OWNER }, "some_tool", {
      summary: "сделать опасное",
      reason: "он попросил",
    });
    expect(res!.output).toMatch(/НЕ ВЫПОЛНЕНО/);
    expect(res!.output).toMatch(/Причина: он попросил/);
    expect(res!.output).toMatch(/\/yes/);
  });
});

describe("approval of a registered action", () => {
  it("runs the action only after the owner approves", async () => {
    let ran = 0;
    registerApprovalApplier("test_action", async () => {
      ran++;
      return { success: true, output: "done" };
    });
    const gate = requireApproval({ _userId: OWNER }, "test_action", {
      summary: "сделать",
      args: { x: 1 },
    });
    expect(gate).not.toBeNull();
    expect(ran).toBe(0);

    const res = await applyPending(OWNER);
    expect(res.ok).toBe(true);
    expect(ran).toBe(1);
  });

  it("reports a failing action instead of claiming success", async () => {
    registerApprovalApplier("test_action_fail", async () => ({
      success: false,
      output: "",
      error: "boom",
    }));
    requireApproval({ _userId: OWNER }, "test_action_fail", { summary: "сделать" });
    const res = await applyPending(OWNER);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/boom/);
  });

  it("says so when the tool never registered an applier", async () => {
    requireApproval({ _userId: OWNER }, "never_registered", { summary: "сделать" });
    const res = await applyPending(OWNER);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/не зарегистрирован/);
  });
});

describe("npm_install gating", () => {
  it("does not install anything when the model asks directly", async () => {
    const res = await npmInstallTool.execute({
      package_name: "some-package-that-does-not-exist",
      _userId: OWNER,
    });
    // The gate returns before exec is ever reached.
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/НЕ ВЫПОЛНЕНО/);
    expect(peek(OWNER)?.action?.name).toBe("npm_install");
    expect(peek(OWNER)?.action?.args).toEqual({ package_name: "some-package-that-does-not-exist" });
  });

  it("rejects shell metacharacters before the gate, not after", async () => {
    const res = await npmInstallTool.execute({
      package_name: "left-pad; rm -rf /",
      _userId: OWNER,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("invalid_name");
    // Nothing parked: a rejected name is not an offer to confirm.
    expect(peek(OWNER)).toBeUndefined();
  });

  it("refuses outright when there is no chat to approve through", async () => {
    const res = await npmInstallTool.execute({ package_name: "lodash" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/подтверждени/i);
  });

  it("still needs a package name", async () => {
    const res = await npmInstallTool.execute({ package_name: "  ", _userId: OWNER });
    expect(res.success).toBe(false);
    expect(res.error).toBe("missing_param");
  });
});
