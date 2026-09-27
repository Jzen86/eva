import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPath, defaultPathPolicy, realPath } from "../../src/core/path-policy.js";

/**
 * The path policy is what stands between the model and the whole filesystem.
 * Every case here is a path the old `files`/`send_file` would have accepted.
 */

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eva-pp-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "eva-pp-out-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const policy = () => ({
  roots: [root],
  deniedFiles: [realPath(path.join(root, "config.yaml"))],
});

describe("classifyPath", () => {
  it("allows a path inside a root", () => {
    expect(classifyPath(path.join(root, "note.txt"), policy()).kind).toBe("allow");
  });

  it("gates a path outside the roots", () => {
    expect(classifyPath(path.join(outside, "note.txt"), policy()).kind).toBe("gate");
  });

  it("gates a traversal that climbs out of the root", () => {
    const escape = path.join(root, "..", path.basename(outside), "x.txt");
    expect(classifyPath(escape, policy()).kind).toBe("gate");
  });

  it("denies the config file", () => {
    expect(classifyPath(path.join(root, "config.yaml"), policy()).kind).toBe("deny");
  });

  it("denies the memory database", () => {
    expect(classifyPath(path.join(root, "eva.db"), policy()).kind).toBe("deny");
    expect(classifyPath(path.join(root, "eva.db-wal"), policy()).kind).toBe("deny");
  });

  it("denies credentials by name", () => {
    expect(classifyPath(path.join(root, ".env"), policy()).kind).toBe("deny");
    expect(classifyPath(path.join(root, "id_rsa"), policy()).kind).toBe("deny");
  });

  it.skipIf(process.platform === "win32")("denies system directories", () => {
    expect(classifyPath("/etc/passwd", policy()).kind).toBe("deny");
    expect(classifyPath("/proc/1/environ", policy()).kind).toBe("deny");
  });

  it("resolves a symlink out of the root as outside", () => {
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch {
      return; // no symlink privilege (Windows without developer mode)
    }
    expect(classifyPath(path.join(link, "x.txt"), policy()).kind).toBe("gate");
  });
});

describe("defaultPathPolicy", () => {
  it("defaults to the config directory and temp", () => {
    const cfg = path.join(outside, "config.yaml");
    const p = defaultPathPolicy(cfg);
    expect(p.roots).toContain(path.dirname(cfg));
    expect(p.roots).toContain(os.tmpdir());
    expect(p.deniedFiles[0]).toBe(realPath(cfg));
  });

  it("takes explicit roots when given them", () => {
    const p = defaultPathPolicy(path.join(outside, "config.yaml"), [path.join(root, "work")]);
    expect(p.roots).toEqual([path.join(root, "work")]);
  });
});
