import type { Tool, ToolResult } from "./types.js";
import { TokenStore } from "../../services/tokens.js";
import { listServices } from "../../services/catalog.js";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`
}

/**
 * Name a page that answers nothing, so the model is not left to fill the gap.
 *
 * The tell-tales are the ones this install actually hit: a search engine's bot
 * check served with a 200, a consent wall, a JavaScript shell. Each is a real
 * response from a real server, which is why a status code cannot catch them.
 */
export function describeEmptyPage(text: string): string | null {
  if (text.length > 200_000) return null; // Too big to be a shell; judge it on content.
  if (/anomaly|unfortunately, bots|are you a robot|enable javascript and cookies/i.test(text)) {
    return "Страница-заглушка: сайт отдал бот-проверку, а не содержимое. Данных здесь нет.";
  }
  if (/just a moment|checking your browser|ddos protection by/i.test(text)) {
    return "Страница-заглушка: сайт проверяет браузер (Cloudflare). Содержимого нет.";
  }
  if (text.trim().length < 200) {
    return `Страница почти пустая (${text.trim().length} символов) — ответа в ней нет.`;
  }
  return null;
}

export interface HttpToolConfig {
  encryptionKey?: string;
}

export class HttpTool implements Tool {
  static readonly MAX_OUTPUT_CHARS = 8000
  private encryptionKey?: string;

  constructor(config?: HttpToolConfig) {
    this.encryptionKey = config?.encryptionKey;
  }

  name = "http"
  description = "Make HTTP API requests (JSON/REST). For browsing websites use the 'web' or 'browser' tool. Authorization headers for connected services (Google, GitHub, VK etc.) are injected AUTOMATICALLY — do NOT set Authorization header manually for these services, just provide the URL."
  parameters = [
    { name: "url", type: "string", description: "The URL to request", required: true },
    { name: "method", type: "string", description: "HTTP method: GET, POST, PUT, or DELETE" },
    { name: "body", type: "string", description: "Request body (for POST/PUT)" },
    { name: "headers", type: "string", description: "JSON-encoded headers object" },
  ]

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string | undefined
    if (!url) {
      return { success: false, output: "", error: "Missing required parameter: url" }
    }

    const method = ((params.method as string) || "GET").toUpperCase()
    const body = params.body as string | undefined

    let headers: Record<string, string> = {}
    if (params.headers) {
      try {
        headers = typeof params.headers === "string" ? JSON.parse(params.headers) : (params.headers as Record<string, string>)
      } catch {
        return { success: false, output: "", error: "Invalid headers: must be a JSON-encoded object" }
      }
    }

    const userId = params._userId as string | undefined;

    // Auto-inject Authorization header for connected services
    // Always overwrite for known service URLs (LLM may put a placeholder like "[TOKEN]")
    if (userId) {
      const authHeader = this.resolveAuthHeader(url, userId);
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      })

      clearTimeout(timer)

      const text = await response.text()

      if (!response.ok) {
        return { success: false, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS), error: `HTTP ${response.status} ${response.statusText}` }
      }

      // A page that exists and contains nothing is the most dangerous thing this
      // tool can hand back. It arrives as 200, it reads as prose, and the model
      // cannot tell it from an answer — so it fills the gap. That is exactly what
      // happened: she was told to search the web, `web` was refused by a bot
      // check, she fetched the search page by hand through `http`, got the bot
      // check back as a success, and answered with patch numbers that appear in
      // no release notes anywhere.
      //
      // So a refusal to serve is named as a refusal. Silently handing over an
      // empty page is not a neutral act: it is an invitation to invent.
      const guard = describeEmptyPage(text);
      if (guard) {
        return {
          success: false,
          output: truncate(text, HttpTool.MAX_OUTPUT_CHARS),
          error: guard,
        }
      }

      return { success: true, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS) }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  resolveAuthHeader(url: string, userId: string): string | null {
    if (!this.encryptionKey) return null;
    const services = listServices();
    for (const svc of services) {
      for (const baseUrl of Object.values(svc.baseUrls)) {
        if (url.startsWith(baseUrl)) {
          const store = new TokenStore(this.encryptionKey);
          const token = store.get(svc.id, userId);
          if (token && !token.isExpired()) {
            return `Bearer ${token.accessToken}`;
          }
        }
      }
    }
    return null;
  }
}
