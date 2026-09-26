import { describe, it, expect, vi, afterEach } from "vitest"
import { WebTool, parseDuckDuckGoHtml, stateWhatWasFound } from "../../src/core/tools/web.js"

describe("WebTool", () => {
  it("has correct name and actions", () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    expect(tool.name).toBe("web")
    expect(tool.parameters.find(p => p.name === "action")).toBeTruthy()
  })

  it("returns error when action is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("action")
  })

  it("returns error when search query is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({ action: "search" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("query")
  })

  it("returns error when read url is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({ action: "read" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("url")
  })

  it("truncates output to MAX_OUTPUT_CHARS", async () => {
    expect(WebTool.MAX_READ_CHARS).toBe(4000)
    // Was 2000, which cut a 3179-character result set in half — so a number the
    // owner asked for could sit in results 7-10, unseen.
    expect(WebTool.MAX_SEARCH_CHARS).toBe(4000)
  })

  // The shape DuckDuckGo's no-JS page actually has, wrapped destinations and all.
  const ddgPage = `<html><body>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.stalker2.com%2Fpatch%2Dnotes&amp;rut=651fcae58e6f">Patch Notes &mdash; S.T.A.L.K.E.R. 2</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Full list of updates &amp; hotfixes</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshacknews.com%2Farticle%2F150689&amp;rut=3c7a">STALKER 2 Patch 2.0.5 notes</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">What changed &amp; when</a>
  </body></html>`

  it("unwraps DuckDuckGo's redirect links instead of handing back a redirect", () => {
    // The href is `/l/?uddg=<encoded>`; taken raw the model gets an address it
    // cannot follow and the search looks broken while it worked.
    const results = parseDuckDuckGoHtml(ddgPage)
    expect(results).toHaveLength(2)
    expect(results[0].link).toBe("https://www.stalker2.com/patch-notes")
    expect(results[0].title).toBe("Patch Notes &mdash; S.T.A.L.K.E.R. 2")
    expect(results[0].snippet).toBe("Full list of updates & hotfixes")
    expect(results[1].link).toBe("https://shacknews.com/article/150689")
  })

  it("searches with no credentials at all", async () => {
    // The reason this tool exists now: on a plain install there is no `cx`, and
    // without a search she reached for browser, then http, then curl. The local
    // instance is tried first and is absent here, so the chain must carry on.
    const tool = new WebTool({})
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(ddgPage) }))

    const result = await tool.execute({ action: "search", query: "stalker 2 patch" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://www.stalker2.com/patch-notes")
    expect(result.output).toContain("1. Patch Notes")

    const first = String(vi.mocked(fetch).mock.calls[0][0])
    const second = String(vi.mocked(fetch).mock.calls[1][0])
    expect(first).toContain("127.0.0.1:8888")
    expect(second).toContain("duckduckgo.com")
  })

  it("falls back to the keyless engine when Google is configured but fails", async () => {
    // A dead Google credential must not read as "no internet". SearXNG is asked
    // first and declines, so the two mocks here are SearXNG then Google.
    const tool = new WebTool({ apiKey: "bad", cx: "gone" })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve("forbidden") })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(ddgPage) }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://www.stalker2.com/patch-notes")
    vi.unstubAllGlobals()
  })

  it("says a bot check is not an empty result set", async () => {
    // The failure this exists to prevent. A 202 anomaly page is not an answer of
    // "nothing found": it is the engine refusing a bot, and reporting it as an
    // empty result set is what convinces her that searching does not work.
    const tool = new WebTool({})
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("<html><body>Unfortunately, bots use DuckDuckGo too</body></html>"),
      }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.success).toBe(false)
    expect(result.output).not.toContain("No results found")
    expect(result.error).toContain("google.cx")
  })

  it("asks the local SearXNG first, because it is there and it is free", async () => {
    // The instance the neighbour bot put on this server was listening the whole
    // time, while the tool asked for a Google `cx` to be created by hand.
    const tool = new WebTool({ searxngUrl: "http://127.0.0.1:8888", language: "ru" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [{ title: "Патч-ноты", url: "https://s2.com/patch", content: "Патч 2.0.5" }],
      }),
    }))

    const result = await tool.execute({ action: "search", query: "патч сталкер 2" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://s2.com/patch")
    expect(result.output).toContain("Патч 2.0.5")

    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    expect(url.origin).toBe("http://127.0.0.1:8888")
    expect(url.searchParams.get("format")).toBe("json")
    expect(url.searchParams.get("language")).toBe("ru")
  })

  it("falls through to the keyless engine when SearXNG is not there", async () => {
    // It lives on this server but not on every install, so its absence must not
    // be the end of the search.
    const tool = new WebTool({ searxngUrl: "http://127.0.0.1:8888" })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(ddgPage) }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://www.stalker2.com/patch-notes")
  })

  it("prefers Google when it is configured and working", async () => {
    const tool = new WebTool({ apiKey: "good", cx: "here", searxngUrl: "http://127.0.0.1:1" })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [{ title: "From Google", link: "https://g.example", snippet: "s" }] }),
      }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.output).toContain("From Google")
    const url = String(vi.mocked(fetch).mock.calls[1][0])
    expect(url).toContain("googleapis.com")
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("stateWhatWasFound", () => {
  // The exact failure: told which patch is the latest, she answered "2.0.6,
  // released 18 September 2026, fixes crashes on AMD". The search had succeeded and
  // the results never contained any of that. A list of links that looks like an
  // answer is the same as no answer at all, and she filled it in completely.
  const genericPages = [
    "1. Patch Notes - full list of updates",
    "   https://www.stalker2.com/patch-notes",
    "   A comprehensive archive of changes, tweaks and fixes.",
    "2. Heart of Chornobyl Patches - SteamDB",
    "   https://steamdb.info/app/1643320/patchnotes/",
    "   Curated patch notes and changelogs.",
  ].join("\n\n");

  it("says the answer is not in the results when no value is there", () => {
    const note = stateWhatWasFound("latest patch version S.T.A.L.K.E.R. 2 2026", genericPages);
    expect(note).toContain("ни одной версии");
    expect(note).toContain("не нашла");
  });

  it("lists the values that are actually there", () => {
    const note = stateWhatWasFound("latest patch version", "Patch 2.0.6 and 1.7.1, 2026");
    expect(note).toContain("2.0.6");
    expect(note).toContain("1.7.1");
  })

  it("stays out of the way for a question that wants no value", () => {
    expect(stateWhatWasFound("расскажи анекдот", "1. Result\n   https://x\n   text")).toBeNull();
  })

  it("puts the note first, before the links she is about to quote", async () => {
    const tool = new WebTool({ searxngUrl: "http://127.0.0.1:8888" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [{ title: "Patch Notes", url: "https://s2.com/p", content: "Archive of changes" }],
      }),
    }))

    const r = await tool.execute({ action: "search", query: "latest patch version" })
    expect(r.output.startsWith("ВНИМАНИЕ")).toBe(true)
    expect(r.output.indexOf("ВНИМАНИЕ")).toBeLessThan(r.output.indexOf("https://"))
  })

  it("keeps the whole result set now", () => {
    expect(WebTool.MAX_SEARCH_CHARS).toBe(4000)
  })
})
