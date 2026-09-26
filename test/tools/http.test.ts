import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { HttpTool, describeEmptyPage } from "../../src/core/tools/http.js"
import { TokenStore } from "../../src/services/tokens.js"
import { getDB, closeDB } from "../../src/core/memory/db.js"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"

describe("HttpTool", () => {
  it("has updated description mentioning API calls", () => {
    const tool = new HttpTool()
    expect(tool.description).toContain("API")
  })

  it("has MAX_OUTPUT_CHARS constant", () => {
    expect(HttpTool.MAX_OUTPUT_CHARS).toBe(8000)
  })
})

describe("HttpTool auth injection", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-http-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";

  beforeEach(() => { closeDB(); getDB(testDbPath); });
  afterEach(() => { closeDB(); try { fs.unlinkSync(testDbPath); } catch {} try { fs.unlinkSync(testDbPath + "-wal"); } catch {} try { fs.unlinkSync(testDbPath + "-shm"); } catch {} });

  it("resolveAuthHeader returns token for matching service URL", () => {
    const store = new TokenStore(encKey);
    store.save({ serviceId: "github", userId: "user1", accessToken: "gh-token-123", scopes: "default", expiresAt: 9999999999 });
    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://api.github.com/user/repos", "user1");
    expect(header).toBe("Bearer gh-token-123");
  });

  it("resolveAuthHeader returns null for unknown URL", () => {
    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://random-api.com/data", "user1");
    expect(header).toBeNull();
  });
});

describe("describeEmptyPage", () => {
  // The failure this guards: `web` was refused by a bot check, so she fetched the
  // search page by hand through `http`, got the bot check back as a 200 success,
  // and answered with patch numbers that exist in no release notes. A 200 is not
  // an answer, and neither is a page that answers nothing.
  it("names a bot check instead of passing it off as content", () => {
    const page = "<html><body><div>Unfortunately, bots use DuckDuckGo too</div></body></html>";
    expect(describeEmptyPage(page)).toContain("бот-проверку");
  });

  it("names a browser challenge", () => {
    expect(describeEmptyPage("<html><title>Just a moment...</title>")).toContain("Cloudflare");
  })

  it("names a page with nothing on it", () => {
    expect(describeEmptyPage("<html></html>")).toContain("пустая");
  })

  it("leaves a real page alone", () => {
    const page = "<html><body>" + "S.T.A.L.K.E.R. 2 patch 2.0.5 notes. ".repeat(20) + "</body></html>";
    expect(describeEmptyPage(page)).toBeNull();
  })

  it("does not judge a huge page by its length", () => {
    // 200k of script can be a real app, and calling that empty would be worse
    // than useless.
    expect(describeEmptyPage("x".repeat(200_001))).toBeNull();
  })
})
