import { describe, it, expect, vi, afterEach } from "vitest"
import { WebTool, parseDuckDuckGoHtml } from "../../src/core/tools/web.js"

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
    expect(WebTool.MAX_SEARCH_CHARS).toBe(2000)
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
    // without a search she reached for browser, then http, then curl.
    const tool = new WebTool({})
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(ddgPage),
    }))

    const result = await tool.execute({ action: "search", query: "stalker 2 patch" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://www.stalker2.com/patch-notes")
    expect(result.output).toContain("1. Patch Notes")

    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain("duckduckgo.com")
    vi.unstubAllGlobals()
  })

  it("falls back to the keyless engine when Google is configured but fails", async () => {
    // A dead Google credential must not read as "no internet".
    const tool = new WebTool({ apiKey: "bad", cx: "gone" })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve("forbidden") })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(ddgPage) }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("https://www.stalker2.com/patch-notes")
    vi.unstubAllGlobals()
  })

  it("prefers Google when it is configured and working", async () => {
    const tool = new WebTool({ apiKey: "good", cx: "here" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ title: "From Google", link: "https://g.example", snippet: "s" }] }),
    }))

    const result = await tool.execute({ action: "search", query: "test" })
    expect(result.output).toContain("From Google")
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain("googleapis.com")
    vi.unstubAllGlobals()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

