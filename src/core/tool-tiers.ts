/**
 * Which tools are heavy enough to be worth the strong model.
 *
 * Every turn starts on `fast` — the chat model — and that same first call
 * decides whether a tool is needed and writes it. For most tools the turn can
 * end there: the result is a fact, a page or a file, and all that is left is to
 * say so, which the chat model does as well as anything. Lifting those turns to
 * `strong` bought nothing, and on a live install it cost a flaky timeout every
 * time a plain web search ran — the search was not the problem, the model it
 * was handed to was.
 *
 * A tool belongs here when the result is a pile of data to reason over, when
 * the action can break something, or when the work is genuinely multi-step:
 * parsing a shell transcript, driving a real browser, installing a package that
 * runs its own scripts, editing the bot's own configuration, reading a
 * diagnosis report and acting on it. That is where the heavier model earns its
 * price.
 *
 * `files` is the exception that is two tools at once: reading is as light as
 * `cat`, writing is the thing the owner has to release. It is judged by
 * `action`, not by name.
 */
const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "browser",
  "npm_install",
  "self_config",
  "doctor",
]);

/** Tools that are heavy only for some actions. */
const HEAVY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  files: new Set(["write"]),
};

/** Is this tool call heavy — worth the strong model for the rest of the turn? */
export function isHeavyToolCall(name: string, args?: Record<string, unknown>): boolean {
  if (HEAVY_TOOLS.has(name)) return true;
  const heavyActions = HEAVY_ACTIONS[name];
  if (!heavyActions) return false;
  const action = args?.action;
  return typeof action === "string" && heavyActions.has(action);
}
