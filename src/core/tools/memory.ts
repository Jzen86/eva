import type { Tool, ToolResult } from "./types.js";
import {
  searchKnowledge,
  getAllKnowledge,
  renderKnowledge,
  type KnowledgeRow,
} from "../memory/knowledge.js";
import { learnInsight, type EmbeddingEndpoint } from "../memory/dedup.js";
import { getDB } from "../memory/db.js";

function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const val = params[key];
  if (typeof val !== "string" || !val.trim()) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return val.trim();
}

/** Same as requireString, but absent and blank are both fine. */
function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const val = params[key];
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function handleSearch(params: Record<string, unknown>): ToolResult {
  const query = requireString(params, "query");
  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? params.limit
      : 5;

  // searchKnowledge already swallows database errors, because a miss must never
  // take down the turn. The tool answers with "nothing found" rather than an
  // error either way, so a broken index degrades to a quiet no instead of a
  // failed model call.
  const hits = searchKnowledge(query, limit);

  // Same rendering the answer prompt uses, so a search made mid-chat hands back
  // evidence framed as evidence. A different shape in each place would mean the
  // framing has to be remembered twice and survives in one of them.
  const rendered = renderKnowledge(hits);
  if (!rendered) {
    return { success: true, output: "No relevant memories found." };
  }

  return { success: true, output: rendered };
}

async function handleSave(
  params: Record<string, unknown>,
  embedding: EmbeddingEndpoint | null,
): Promise<ToolResult> {
  const insight = requireString(params, "content");
  const topic =
    typeof params.topic === "string" && params.topic.trim()
      ? params.topic.trim()
      : "general";

  // A case is anything that records her doing something and him answering it.
  // The fields are optional so a plain fact about a person still saves, but the
  // three travel together: her_move without the other two is the note that reads
  // back as a rule, and it is cheaper to refuse it here than to explain why
  // later.
  const herMove = optionalString(params, "her_move");
  const context = optionalString(params, "context");
  const hisReaction = optionalString(params, "his_reaction");

  if (herMove && (!context || !hisReaction)) {
    return {
      success: false,
      output:
        "A case needs all three: her_move (what she did), context (the state he " +
        "was in), his_reaction (what he did about it). Without the context the " +
        "note is read back as a rule instead of a moment. Save it as a plain " +
        "fact with no her_move, or fill in all three.",
      error: "incomplete_case",
    };
  }

  // Through the shared writer, so a memory the agent volunteers goes through
  // the same dedup check as one a study session produces. Without this, Eva
  // could answer "не люблю грибы", store it, and then store "люблю грибы"
  // right after it — both passing straight to the table.
  const outcome = await learnInsight(
    {
      topic,
      insight,
      source: "memory_tool",
      her_move: herMove ?? undefined,
      context: context ?? undefined,
      his_reaction: hisReaction ?? undefined,
    },
    { embedding },
  );

  if (!outcome.written) {
    return {
      success: true,
      output: `Not saved — ${outcome.reason}. Entry #${outcome.duplicate?.id ?? "?"} already says it.`,
    };
  }
  return { success: true, output: `Saved knowledge entry #${outcome.id}.` };
}

/**
 * Remove an entry.
 *
 * The owner asking for a specific id means it outright, so this one really
 * deletes. A retired row (trimmed or superseded) is a different thing and is
 * not reachable from here — it is already out of the search index.
 */
function handleDelete(params: Record<string, unknown>): ToolResult {
  const id = requireString(params, "id");
  const db = getDB();
  const result = db.prepare("DELETE FROM knowledge WHERE id = ?").run(Number(id));
  if (result.changes === 0) {
    return { success: false, output: `Entry not found: ${id}`, error: "not_found" };
  }
  return { success: true, output: `Deleted entry ${id}.` };
}

function handleList(params: Record<string, unknown>): ToolResult {
  // Retired rows are hidden by default; `include_retired=1` shows them, which is
  // the only way to see what the base dropped and when.
  const includeRetired = params.include_retired === true || params.include_retired === 1;
  const entries = getAllKnowledge(includeRetired);
  if (entries.length === 0) {
    return { success: true, output: "Knowledge base is empty." };
  }

  const summary = entries
    .map((e: KnowledgeRow) => {
      const state = e.superseded_at ? ` (retired, superseded by #${e.superseded_by ?? "?"})` : "";
      const used = e.access_count ? ` [used ${e.access_count}x]` : "";
      return `- ${e.id}: [${e.topic}] ${e.insight.slice(0, 120)}${used}${state}`;
    })
    .join("\n");

  return {
    success: true,
    output: `${entries.length} entries:\n${summary}`,
  };
}

export interface MemoryToolOptions {
  /**
   * Endpoint for semantic dedup. Omit it and saves are checked lexically only,
   * which is a supported mode rather than a degraded one.
   */
  embedding?: EmbeddingEndpoint | null;
}

export function createMemoryTool(opts: MemoryToolOptions = {}): Tool {
  const embedding = opts.embedding ?? null;

  return {
    name: "memory",
    description:
      "Knowledge base: search it, save what just happened, list or delete entries.\n" +
      "action=save takes what actually happened, not a conclusion drawn from it. A " +
      "plain fact about him ('не любит айфоны') goes in content alone.\n" +
      "When he reacted to something you did, save that as a case instead: her_move = " +
      "what you did, context = the state he was in (busy, cheerful, in an " +
      "argument, tired), his_reaction = what he did about it. All three are required " +
      "together. The context is not decoration: without it the note comes back as a " +
      "rule, and rules are what this base is not for. Save what happened, each time " +
      "it happens — two cases about the same thing in different states are both true.",
    parameters: [
      { name: "action", type: "string", description: "One of: search, save, delete, list", required: true },
      { name: "query", type: "string", description: "Search query (required for action=search)" },
      { name: "content", type: "string", description: "Knowledge content to save (required for action=save)" },
      { name: "topic", type: "string", description: "Topic tag for the entry (optional, default: general)" },
      {
        name: "her_move",
        type: "string",
        description: "Case only: what she did or said that he reacted to",
      },
      {
        name: "context",
        type: "string",
        description: "Case only, required: the state he was in when it happened",
      },
      {
        name: "his_reaction",
        type: "string",
        description: "Case only, required: how he answered it (warmed up, went cold, laughed, let it go)",
      },
      { name: "id", type: "string", description: "Entry ID (required for action=delete)" },
      { name: "limit", type: "number", description: "Max results for search (default 5)" },
      {
        name: "include_retired",
        type: "boolean",
        description: "With action=list, also show entries that were retired (action=list only)",
      },
    ],

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const action = requireString(params, "action");

        switch (action) {
          case "search":
            return handleSearch(params);
          case "save":
            return await handleSave(params, embedding);
          case "delete":
            return handleDelete(params);
          case "list":
            return handleList(params);
          default:
            return {
              success: false,
              output: `Unknown action: ${action}. Use search, save, delete, or list.`,
              error: "invalid_action",
            };
        }
      } catch (err) {
        // The tool boundary is the last place a database problem can be turned
        // into a sentence the model can react to instead of a broken turn.
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Memory action failed: ${message}`,
          error: "memory_error",
        };
      }
    },
  };
}

/** Kept for callers that register the tool without an embedding endpoint. */
export const memoryTool: Tool = createMemoryTool();
