/**
 * Changes waiting for the owner to say yes.
 *
 * `Tool.requiresConfirmation` existed on the tool interface and was set by
 * three tools — and read by nothing. npm-install went further and told the
 * model in its own description that anything but an allowlisted package
 * "requires explicit approval", while trusting a package-name prefix to cover
 * the rest. Nothing approved anything. The flag was decoration.
 *
 * This is the thing that actually holds a change back. A gated call does not
 * take effect: it parks here, and the owner releases it with /yes. The
 * alternatives — asking the model to ask, or trusting a confirmation phrase in
 * the conversation — both keep the decision inside the same loop that wanted
 * the change, which is exactly what a confirmation is supposed to interrupt.
 *
 * In memory on purpose. A proposal is short-lived and cheap to re-make; it
 * should not survive a restart, and there is no reason to put a config value
 * or a command line on disk twice.
 */

import { patchConfigOrThrow, getNestedValue, setNestedValue } from "./config.js";
import type { ToolResult } from "./tools/types.js";

export type PendingKind = "config_set" | "config_append" | "action";

export interface PendingChange {
  /** Who proposed it — the chat the /yes will come from. */
  ownerId: string;
  kind: PendingKind;
  /** Dot-notation config key. Set for the config kinds. */
  key?: string;
  value?: unknown;
  /** Tool name and arguments, for the action kind. */
  action?: { name: string; args: Record<string, unknown> };
  /** One line shown to the owner on the approval line. */
  summary: string;
  /** What the model said it was doing, also shown to the owner. */
  reason: string;
  createdAt: number;
}

/**
 * One proposal per owner, newest replacing the previous.
 *
 * A queue would need an id in every approval, and "/yes" approving whichever
 * happened to be first is how the wrong thing gets approved. Replacing means
 * there is never an ambiguity to resolve, and the owner always sees the
 * proposal they are answering.
 */
const pending = new Map<string, PendingChange>();

/**
 * How to actually carry out a parked action.
 *
 * Registered by the tool itself, so the tool owns its own side effects and
 * this file never has to know that `npm_install` shells out.
 */
type ActionApplier = (args: Record<string, unknown>) => Promise<ToolResult>;

const appliers = new Map<string, ActionApplier>();

/** Teach the approval flow how to run this tool once the owner says yes. */
export function registerApprovalApplier(tool: string, apply: ActionApplier): void {
  appliers.set(tool, apply);
}

/** Park a change instead of applying it. Returns what was stored. */
export function propose(
  ownerId: string,
  change: Omit<PendingChange, "ownerId" | "createdAt">,
): PendingChange {
  const stored: PendingChange = { ...change, ownerId, createdAt: Date.now() };
  pending.set(ownerId, stored);
  return stored;
}

/** Look without consuming — used to tell the owner what a /yes would do. */
export function peek(ownerId: string): PendingChange | undefined {
  return pending.get(ownerId);
}

/** Throw the proposal away. Returns what was discarded, if anything. */
export function discard(ownerId: string): PendingChange | undefined {
  const existing = pending.get(ownerId);
  pending.delete(ownerId);
  return existing;
}

/**
 * The gate itself: park the action and return the reply to send back.
 *
 * Returns a refusal instead when there is no chat to approve through — the
 * change would sit forever and the caller would have no idea why. Returns
 * null when the call may proceed.
 */
export function requireApproval(
  params: Record<string, unknown>,
  tool: string,
  opts: { summary: string; reason?: string; args?: Record<string, unknown> },
): ToolResult | null {
  const ownerId = typeof params._userId === "string" ? params._userId : null;
  if (!ownerId) {
    return {
      success: false,
      output: "",
      error:
        `${tool} требует подтверждения владельца, а подтвердить нечем: вызов без чата. ` +
        `Действие не выполнено.`,
    };
  }
  const reason = opts.reason?.trim() ?? "";
  const parked = propose(ownerId, {
    kind: "action",
    action: { name: tool, args: opts.args ?? {} },
    summary: opts.summary,
    reason,
  });
  const because = reason ? ` Причина: ${reason}.` : "";
  return {
    success: true,
    output:
      `⏸ Жду подтверждения. Предложено: ${parked.summary}.${because} ` +
      `НЕ ВЫПОЛНЕНО. Скажи владельцу, что нужно подтвердить это действие ` +
      `(/yes — принять, /no — отклонить), и не повторяй попытку: ` +
      `она снова придёт сюда же.`,
  };
}

/**
 * Apply the pending change and consume it.
 *
 * Config changes apply to the live file, not to a snapshot:
 * `patchConfigOrThrow` re-reads the config, so a change approved five minutes
 * after being proposed lands on top of whatever happened in between instead
 * of rolling it back.
 */
export async function applyPending(ownerId: string): Promise<{ ok: boolean; message: string }> {
  const change = pending.get(ownerId);
  if (!change) {
    return { ok: false, message: "Нечего подтверждать — я ничего не предлагала." };
  }
  // Consumed before the work, so a failed write cannot be approved twice into
  // the same error.
  pending.delete(ownerId);

  try {
    if (change.kind === "config_set" || change.kind === "config_append") {
      const key = change.key as string;
      if (change.kind === "config_append") {
        patchConfigOrThrow((config) => {
          const existing = getNestedValue(config, key);
          const arr = Array.isArray(existing) ? [...existing] : [];
          arr.push(String(change.value));
          setNestedValue(config, key, arr);
        });
      } else {
        patchConfigOrThrow((config) => setNestedValue(config, key, change.value));
      }
      return { ok: true, message: `Готово: ${describe(change)}` };
    }

    const name = change.action?.name as string;
    const apply = appliers.get(name);
    if (!apply) {
      return { ok: false, message: `Нечем выполнить «${name}» — исполнитель не зарегистрирован.` };
    }
    const result = await apply(change.action?.args ?? {});
    if (!result.success) {
      return { ok: false, message: `Не получилось: ${result.error ?? result.output}` };
    }
    return { ok: true, message: `Готово: ${change.summary}` };
  } catch (err) {
    return {
      ok: false,
      message: `Не получилось: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One line describing a change, for the approval prompt and the result. */
export function describe(change: PendingChange): string {
  if (change.kind === "action") return change.summary;
  if (change.kind === "config_append") return `добавлено в ${change.key}`;
  const value =
    typeof change.value === "string" ? change.value : JSON.stringify(change.value);
  const clipped = value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return `${change.key} = ${clipped}`;
}
