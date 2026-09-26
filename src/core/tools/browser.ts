import type { Browser, BrowserContext, Page } from "playwright";
import type { Tool, ToolParam, ToolResult } from "./types.js";
import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_CHARS = 4000;

const PLAYWRIGHT_CACHE = path.join(
  process.env.HOME ?? "/root",
  ".cache",
  "ms-playwright",
);

/** Browser builds sitting in the cache, newest last: `chromium_headless_shell-1243`. */
export function installedBrowserBuilds(): string[] {
  try {
    return fs
      .readdirSync(PLAYWRIGHT_CACHE)
      .filter((name) => name.startsWith("chromium"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A one-line warning when the browser cannot launch, for the startup banner.
 *
 * The reason this check exists: a `browser` that cannot start is not a tool that
 * fails sometimes, it is the whole way she reaches the internet. It sat broken
 * on every single page for the life of the install, saying nothing until someone
 * asked her to open a page — and the visible result was not a broken tool, it
 * was a girl answering from memory, sounding like she had forgotten how to look
 * anything up.
 *
 * The path comes from Playwright's own `executablePath()`, which is the same
 * answer `launch()` gives, so this check cannot drift from the failure it
 * predicts. A hardcoded path in a diagnostic is how a diagnostic starts lying.
 *
 * Returns an empty string when there is nothing to say.
 */
export async function describeBrowserInstall(registered: boolean): Promise<string> {
  if (!registered) return "";
  let exe: string;
  try {
    const { chromium } = await import("playwright");
    exe = chromium.executablePath();
  } catch {
    return "";
  }
  if (fs.existsSync(exe)) return "";

  const wanted = exe.match(/chromium(?:_headless_shell)?-(\d+)/)?.[1];
  const have = installedBrowserBuilds();
  return (
    `🌐 browser НЕ РАБОТАЕТ: playwright ждёт сборку ${wanted ?? "?"}, ` +
    `а на сервере ${have.length ? have.join(", ") : "ничего"}. ` +
    "Она не откроет ни одной страницы, пока не выполнено: npx playwright install chromium"
  );
}

/**
 * What is actually wrong with the browser, in words.
 *
 * The generic version of this message — "Chromium не найден, поставь
 * npx playwright install chromium" — is what this install got, and it was
 * wrong: Chromium *was* there, 641 MB of it. The Playwright package had been
 * upgraded underneath it and wanted build 1243 while the cache held 1223, so
 * every single page failed with a message telling the owner to install a browser
 * he had already installed. Nobody acted on it, and a tool that had never once
 * worked looked like a model that had lost the internet.
 *
 * A version skew and a missing browser are the same symptom and opposite fixes,
 * so the message has to tell them apart.
 */
export function describeBrowserMiss(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const wanted = raw.match(/chromium(?:_headless_shell)?-(\d+)/)?.[1];
  const present = installedBrowserBuilds();

  if (wanted && present.length && !present.some((b) => b.endsWith(`-${wanted}`))) {
    const have = present.map((b) => b.replace(/^chromium_?/, "").replace(/-\d+$/, "")).join(", ");
    return (
      `Chromium не той версии: playwright ждёт сборку ${wanted}, а в кэше ${have}. ` +
      "Версии Playwright и браузера разъехались — лечится одной командой, а не поиском chromium."
    );
  }
  if (wanted && !present.length) {
    return `Браузер не скачан: playwright ждёт сборку ${wanted}, а кэш ${PLAYWRIGHT_CACHE} пуст.`;
  }
  return `Chromium не найден: ${raw.slice(0, 200)}.`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`;
}

type BrowserAction = "get_text" | "screenshot" | "click" | "fill" | "evaluate";

const TIMEOUT = 30_000;

const PARAMETERS: ToolParam[] = [
  { name: "action", type: "string", description: "Action to perform: get_text, screenshot, click, fill, evaluate", required: true },
  { name: "url", type: "string", description: "URL to navigate to" },
  { name: "selector", type: "string", description: "CSS selector for click/fill actions" },
  { name: "value", type: "string", description: "Value for fill/search actions" },
  { name: "script", type: "string", description: "JavaScript to evaluate on the page" },
];

export class BrowserTool implements Tool {
  readonly name = "browser";
  readonly description = "Browse websites with a real browser (Playwright). Use when the 'web' tool can't access a site, or for interactive tasks like clicking and filling forms.";
  readonly parameters = PARAMETERS;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as BrowserAction | undefined;
    if (!action) {
      return { success: false, output: "", error: "Missing required parameter: action" };
    }

    try {
      const page = await this.getPage();

      switch (action) {
        case "get_text":
          return await this.getText(page, params.url as string | undefined);
        case "screenshot":
          return await this.screenshot(page, params.url as string | undefined);
        case "click":
          return await this.click(page, params.selector as string | undefined);
        case "fill":
          return await this.fill(page, params.selector as string | undefined, params.value as string | undefined);
        case "evaluate":
          return await this.evaluateScript(page, params.script as string | undefined);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    if (browser) {
      await browser.close();
    }
  }

  // ---- private ----------------------------------------------------------

  private async getPage(): Promise<Page> {
    if (this.page) return this.page;

    // Playwright is an optional dependency. The import failing is the normal
    // case on an install that did not ask for a browser, and it has to read as
    // "this capability is not here" rather than as a crash.
    let chromium: typeof import("playwright")["chromium"];
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error(
        "Браузер не установлен (нет playwright). Включи tools.browser в config.yaml " +
          "и поставь: npm install playwright && npx playwright install chromium",
      );
    }

    try {
      this.browser = await chromium.launch({ headless: true });
    } catch (err) {
      // Deliberately no auto-install here. The previous version downloaded
      // ~150 MB of Chromium on the production server, at request time, as the
      // service user, because a tool call had failed — the decision to fetch
      // and run a third-party binary belongs to whoever installs the bot, not
      // to whichever page the model decided to open. The fix is one command
      // the owner can see and schedule.
      throw new Error(`${describeBrowserMiss(err)} Поставь его на сервере: npx playwright install chromium`);
    }

    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUT);
    return this.page;
  }

  private async getText(page: Page, url: string | undefined): Promise<ToolResult> {
    if (!url) return { success: false, output: "", error: "Missing required parameter: url" };
    await page.goto(url, { timeout: TIMEOUT, waitUntil: "load" });
    // Wait a bit for JS-rendered content (SPAs like Wildberries)
    await page.waitForTimeout(2000);
    const text = await page.textContent("body") ?? "";
    const cleaned = text.replace(/\s+/g, " ").trim();
    return { success: true, output: truncate(cleaned, MAX_TEXT_CHARS) };
  }

  private async screenshot(page: Page, url: string | undefined): Promise<ToolResult> {
    if (!url) return { success: false, output: "", error: "Missing required parameter: url" };
    await page.goto(url, { timeout: TIMEOUT, waitUntil: "load" });
    await page.waitForTimeout(2000);
    const buffer = await page.screenshot({ fullPage: true });
    return { success: true, output: buffer.toString("base64") };
  }

  private async click(page: Page, selector: string | undefined): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: "Missing required parameter: selector" };
    await page.click(selector, { timeout: TIMEOUT });
    return { success: true, output: `Clicked: ${selector}` };
  }

  private async fill(page: Page, selector: string | undefined, value: string | undefined): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: "Missing required parameter: selector" };
    if (value === undefined) return { success: false, output: "", error: "Missing required parameter: value" };
    await page.fill(selector, value, { timeout: TIMEOUT });
    return { success: true, output: `Filled ${selector} with value` };
  }

  private async evaluateScript(page: Page, script: string | undefined): Promise<ToolResult> {
    if (!script) return { success: false, output: "", error: "Missing required parameter: script" };
    const result = await page.evaluate(script);
    if (result === undefined || result === null) return { success: true, output: "" };
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { success: true, output };
  }
}

