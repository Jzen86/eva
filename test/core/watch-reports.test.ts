import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { reportsDir, reportPath, appendReport } from "../../src/core/watch-reports.js";

/**
 * The archive exists so her reports can be read later without digging through
 * the conversation table. Two things can go wrong and both are silent: the file
 * lands somewhere nobody looks (a path built by hand), or a task name escapes
 * the directory (a name is not a filename). These tests pin both.
 */

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `eva-reports-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, "config.yaml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reportsDir", () => {
  it("sits beside the config, so EVA_CONFIG_PATH moves it too", () => {
    expect(reportsDir(configPath)).toBe(path.join(dir, "reports"));
  });
});

describe("reportPath", () => {
  it("is a markdown file inside the reports directory", () => {
    expect(reportPath("self_watch", configPath)).toBe(path.join(dir, "reports", "self_watch.md"));
  });

  it("never lets a task name point outside the directory", () => {
    // A name comes from a database row and is not a filename. `..`, a slash, or
    // a Windows drive letter must all end up as one flat file inside `reports`.
    const root = path.resolve(reportsDir(configPath));
    for (const name of ["../evil", "a/b", "..", "", "....", "C:\\Windows\\x", "sub/../../out"]) {
      const resolved = path.resolve(reportPath(name, configPath));
      expect(path.dirname(resolved)).toBe(root);
      expect(path.basename(resolved).endsWith(".md")).toBe(true);
    }
  });
});

describe("appendReport", () => {
  const when = new Date("2026-10-12T03:00:00.000Z");

  it("writes the report under a dated heading and says where", () => {
    const file = appendReport("self_watch", "Нашла две нестыковки.", when, configPath);
    expect(file).toBe(path.join(dir, "reports", "self_watch.md"));

    const text = fs.readFileSync(file!, "utf8");
    expect(text).toContain("## 2026-10-12 03:00 UTC — self_watch");
    expect(text).toContain("Нашла две нестыковки.");
  });

  it("creates the directory when the install has none yet", () => {
    const nested = path.join(dir, "fresh", "config.yaml");
    const file = appendReport("server_watch", "Всё штатно.", when, nested);
    expect(fs.existsSync(file!)).toBe(true);
    expect(file).toBe(path.join(dir, "fresh", "reports", "server_watch.md"));
  });

  it("appends instead of overwriting, oldest first", () => {
    appendReport("self_watch", "первый", new Date("2026-10-12T03:00:00.000Z"), configPath);
    appendReport("self_watch", "второй", new Date("2026-10-12T15:00:00.000Z"), configPath);

    const text = fs.readFileSync(reportPath("self_watch", configPath), "utf8");
    expect(text.indexOf("первый")).toBeLessThan(text.indexOf("второй"));
    expect(text).toContain("## 2026-10-12 15:00 UTC — self_watch");
  });

  it("keeps each task in its own file", () => {
    appendReport("self_watch", "по коду", when, configPath);
    appendReport("server_watch", "по серверу", when, configPath);

    expect(fs.readFileSync(reportPath("self_watch", configPath), "utf8")).not.toContain("по серверу");
    expect(fs.readFileSync(reportPath("server_watch", configPath), "utf8")).not.toContain("по коду");
  });

  it("writes nothing for a blank report — silence is not an empty entry", () => {
    expect(appendReport("self_watch", "   \n  ", when, configPath)).toBeNull();
    expect(fs.existsSync(reportPath("self_watch", configPath))).toBe(false);
  });
});
