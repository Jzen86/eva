import { describe, it, expect } from "vitest";
import { BrowserTool, refuseNonWebUrl } from "../../../src/core/tools/browser.js";

describe("BrowserTool", () => {
  it("has correct name and parameters", () => {
    const tool = new BrowserTool();
    expect(tool.name).toBe("browser");
    expect(tool.parameters.length).toBeGreaterThan(0);
  });

  it("has correct description", () => {
    const tool = new BrowserTool();
    expect(tool.description).toContain("Browse websites");
  });

  it("returns error for missing action", async () => {
    const tool = new BrowserTool();
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("action");
  });

  // NOTE: Skip actual browser tests in CI — they need Chromium installed
  // The test below is for local validation only
  it.skip("gets text from example.com", async () => {
    const tool = new BrowserTool();
    try {
      const result = await tool.execute({ action: "get_text", url: "https://example.com" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Example Domain");
    } finally {
      await tool.dispose();
    }
  });

  it("refuses anything that is not the web", () => {
    // Playwright opens `file://` as happily as a page, and this tool has no path
    // policy of its own: `get_text url=file:///root/.eva/config.yaml` would have
    // put the install's keys in the chat in one call.
    expect(refuseNonWebUrl("file:///root/.eva/config.yaml")?.success).toBe(false);
    expect(refuseNonWebUrl("data:text/html,<b>x</b>")?.success).toBe(false);
    expect(refuseNonWebUrl(undefined)?.success).toBe(false);
    expect(refuseNonWebUrl("https://example.com/x")).toBeNull();
    expect(refuseNonWebUrl("http://127.0.0.1:8188/")).toBeNull();
  });
});
