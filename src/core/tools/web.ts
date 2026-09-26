import type { Tool, ToolResult } from "./types.js"

export interface WebToolConfig {
  apiKey?: string
  cx?: string
  /** A SearXNG instance. It is the first thing tried, because it is free, local and has no quota. */
  searxngUrl?: string
  /** Two-letter code for the results' language. */
  language?: string
}

/** Where the sibling service on this very server listens; overridable, not mandatory. */
export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`
}

/** Both engines block a default fetch UA, and a 403 with a bot UA looks like a broken tool. */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function formatResults(items: Array<{ title: string; link: string; snippet: string }>): string {
  return items
    .slice(0, 10)
    .map((item, i) => `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet}`)
    .join("\n\n")
}

/**
 * Pull results out of DuckDuckGo's no-JavaScript page.
 *
 * DDG wraps every destination in `/l/?uddg=<url-encoded>`, so the href is not
 * the address: read raw, it hands the model a redirect it cannot follow, and the
 * search looks broken while it worked.
 */
export function parseDuckDuckGoHtml(html: string): Array<{ title: string; link: string; snippet: string }> {
  const results: Array<{ title: string; link: string; snippet: string }> = []
  const seen = new Set<string>()
  const snippets: string[] = []
  for (const m of html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
    snippets.push(unescapeHtml(m[1]))
  }

  let index = 0
  for (const match of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const rawHref = match[1].replace(/&amp;/g, "&")
    const wrapped = rawHref.match(/[?&]uddg=([^&]+)/)
    const link = wrapped ? decodeURIComponent(wrapped[1]) : rawHref.startsWith("//") ? `https:${rawHref}` : rawHref
    if (!link || seen.has(link)) continue
    seen.add(link)
    results.push({ title: unescapeHtml(match[2]), link, snippet: snippets[index] ?? "" })
    index += 1
  }
  return results
}

export class WebTool implements Tool {
  static readonly MAX_READ_CHARS = 4000
  static readonly MAX_SEARCH_CHARS = 2000

  readonly name = "web"
  readonly description = "Search the web and read web pages. Use 'search' to find information, 'read' to get page content as clean text. For interactive browsing (clicking, forms) use the 'browser' tool. For API calls use the 'http' tool. When the question asks for a specific value — a version, a number, a date, a price — put that value in the query: 'latest patch version number', not 'latest news about updates'. A general query returns general pages, and the number is not in them."
  readonly parameters = [
    { name: "action", type: "string", description: "Action: search or read", required: true },
    { name: "query", type: "string", description: "Search query (for action=search)" },
    { name: "url", type: "string", description: "URL to read (for action=read)" },
  ]

  private config: WebToolConfig

  constructor(config: WebToolConfig) {
    this.config = config
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string | undefined
    if (!action) {
      return { success: false, output: "", error: "Missing required parameter: action (search or read)" }
    }

    switch (action) {
      case "search":
        return this.search(params.query as string | undefined)
      case "read":
        return this.read(params.url as string | undefined)
      default:
        return { success: false, output: "", error: `Unknown action: ${action}. Use 'search' or 'read'.` }
    }
  }

  /**
   * Search, in order of what is actually available on this machine.
   *
   * The order used to start at Google's Programmable Search, which needs a key
   * and a `cx` from a search engine somebody has to build by hand in a browser.
   * Without both, `web` did not exist, and every start said so. What she did
   * instead was reach for `browser`, fail, then `http`, then `shell` with curl:
   * three tools to do what one search would have done, which reads as a model
   * that has lost the habit.
   *
   * Meanwhile a SearXNG instance was running on the same server the whole time,
   * put there for the neighbour bot, free, local and without a quota. Nobody
   * looked for it. So: SearXNG first, Google if it was ever configured, and a
   * keyless public engine last. Nothing has to be installed for search to work.
   */
  private async search(query: string | undefined): Promise<ToolResult> {
    if (!query) {
      return { success: false, output: "", error: "Missing required parameter: query" }
    }

    // SearXNG first. It is already running on this server for the neighbour bot,
    // it needs no key, no account and no quota, and it aggregates a dozen engines
    // — so it answers the question the owner actually has. Everyone was looking
    // for a key to configure while a working search sat on localhost the whole
    // time, and the symptom was a girl who seemed to have forgotten the internet.
    const searxng = await this.searchSearxNg(query);
    if (searxng?.success) return searxng;
    if (searxng?.error) console.log(`🔍 web: SearXNG не ответил (${searxng.error}), дальше по списку`);

    if (this.config.apiKey && this.config.cx) {
      const google = await this.searchGoogle(query)
      if (google?.success) return google
      console.log(`🔍 web: Google не ответил (${google?.error ?? "?"}), пробую без ключа`)
    }
    return this.searchDuckDuckGo(query)
  }

  private async searchSearxNg(query: string): Promise<ToolResult> {
    const base = (this.config.searxngUrl ?? DEFAULT_SEARXNG_URL).replace(/\/+$/, "")
    try {
      const url = new URL(`${base}/search`)
      url.searchParams.set("q", query)
      url.searchParams.set("format", "json")
      if (this.config.language) url.searchParams.set("language", this.config.language)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      const res = await fetch(url.toString(), { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) return { success: false, output: "", error: `SearXNG ${res.status}` }

      const data = await res.json() as {
        results?: Array<{ title?: string; url?: string; content?: string }>
      }
      const items = (data.results ?? [])
        .filter((r): r is { title: string; url: string; content: string } => Boolean(r.url))
        .map((r) => ({ title: r.title ?? r.url, link: r.url, snippet: r.content ?? "" }))

      if (!items.length) return { success: true, output: "No results found." }
      return { success: true, output: truncate(formatResults(items), WebTool.MAX_SEARCH_CHARS) }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  private async searchGoogle(query: string): Promise<ToolResult> {
    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1")
      url.searchParams.set("key", this.config.apiKey!)
      url.searchParams.set("cx", this.config.cx!)
      url.searchParams.set("q", query)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(url.toString(), { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) {
        const text = await res.text()
        return { success: false, output: "", error: `Google Search API error ${res.status}: ${text.slice(0, 200)}` }
      }

      const data = await res.json() as {
        items?: Array<{ title: string; link: string; snippet: string }>
      }

      if (!data.items?.length) {
        return { success: true, output: "No results found." }
      }

      return { success: true, output: truncate(formatResults(data.items), WebTool.MAX_SEARCH_CHARS) }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  /**
   * The keyless engine, for an install with no search credential.
   *
   * Honest scope: this works, and it is not a guarantee. DuckDuckGo's no-JS page
   * answers a fresh request and then starts answering `202 anomaly` — a bot
   * check — and from a server IP it stays that way. Every other keyless engine
   * measured refused us outright: Mojeek serves an empty shell, Brave and
   * Startpage answer 429 and a captcha, s.jina.ai now wants an API key, and
   * searx instances rate-limit. So this is a working fallback, not a substitute
   * for a credential — and the tool must never claim otherwise.
   */
  private async searchDuckDuckGo(query: string): Promise<ToolResult> {
    try {
      const url = new URL("https://html.duckduckgo.com/html/")
      url.searchParams.set("q", query)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html" },
      })
      clearTimeout(timer)

      if (!res.ok) {
        return { success: false, output: "", error: `DuckDuckGo error ${res.status}` }
      }

      const html = await res.text()
      // A bot check comes back as 200/202 with a page that says "anomaly" and
      // holds no results. Reporting that as "no results found" is the worst
      // possible answer: it tells her the information does not exist, and she
      // concludes she cannot search. It is the exact failure this whole change
      // was meant to end.
      if (/anomaly|unfortunately, bots|are you a robot/i.test(html)) {
        return {
          success: false,
          output: "",
          error:
            "Поиск без ключа не прошёл: DuckDuckGo считает бота и не отдаёт выдачу. Это не «ничего не найдено». " +
            "Спроси владельца про ключ google.cx (бесплатно, 3 минуты) — либо до тех пор бери адрес напрямую " +
            "через http или browser.",
        }
      }

      const items = parseDuckDuckGoHtml(html)
      if (!items.length) {
        return { success: true, output: "No results found." }
      }
      return { success: true, output: truncate(formatResults(items), WebTool.MAX_SEARCH_CHARS) }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  private async read(url: string | undefined): Promise<ToolResult> {
    if (!url) {
      return { success: false, output: "", error: "Missing required parameter: url" }
    }

    try {
      const jinaUrl = `https://r.jina.ai/${url}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(jinaUrl, {
        signal: controller.signal,
        headers: {
          "Accept": "text/markdown",
          "User-Agent": "Eva/1.0 (AI Assistant)",
        },
      })
      clearTimeout(timer)

      if (res.ok) {
        const text = await res.text()
        if (text.length >= 100) {
          return { success: true, output: truncate(text, WebTool.MAX_READ_CHARS) }
        }
      }
    } catch {
      // Jina failed — fall through to error
    }

    return {
      success: false,
      output: "",
      error: `Could not read ${url} via Jina Reader. Try using the 'browser' tool with action 'get_text' as fallback.`,
    }
  }
}
