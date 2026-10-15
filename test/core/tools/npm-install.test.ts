import { describe, it, expect, beforeEach } from "vitest";
import { npmInstallTool } from "../../../src/core/tools/npm-install.js";
import { discard, peek } from "../../../src/core/pending.js";

/**
 * The name is a name before it is a shell word.
 *
 * This is the one place where a string from the model ends up inside `exec`, so the
 * validation is written as "what a package name may look like" rather than "which
 * characters are dangerous": a blacklist can never be longer than the list of things
 * that turn a word into a command, and the one that stood here
 * (`[;&|`$(){}[\]<>!#]`) had no whitespace, no quote and no backslash in it.
 */

const OWNER = "owner-npm";

describe("npm_install", () => {
  beforeEach(() => discard(OWNER));

  it("refuses a name that would be a second command", async () => {
    const bad = [
      "lodash\nreboot",       // the newline the blacklist did not contain
      "lodash reboot",
      "lodash;reboot",
      "lodash`reboot`",
      'lodash"x',
      "lodash\\x",
      "-g",                    // a flag is not a package
      "$(reboot)",
      "../evil",
    ];
    for (const name of bad) {
      const res = await npmInstallTool.execute({ package_name: name, _userId: OWNER });
      expect(res.success, name).toBe(false);
      expect(res.error, name).toBe("invalid_name");
    }
    // Nothing was even parked: an invalid name never reaches the owner's tap.
    expect(peek(OWNER)).toBeUndefined();
  });

  it("parks a name that looks like a package, and remembers exactly it", async () => {
    for (const name of ["lodash", "@scope/pkg", "lodash@4.17.21", "lodash@latest", "Base64"]) {
      discard(OWNER);
      const res = await npmInstallTool.execute({
        package_name: name,
        reason: "нужен для задачи",
        _userId: OWNER,
      });
      expect(res.success, name).toBe(true);
      expect(res.output, name).toContain("Жду подтверждения");
      expect(peek(OWNER)?.action?.args?.package_name, name).toBe(name);
    }
  });

  it("refuses outright when there is no chat to approve through", async () => {
    const res = await npmInstallTool.execute({ package_name: "lodash" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("подтверждения владельца");
  });
});
