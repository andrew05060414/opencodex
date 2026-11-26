import type { EffectiveSubagentModel } from "../../codex/catalog/subagent-roster";
import type { OcxTool } from "../../types";

// PX-1276: rewrite the "Available model overrides" block inside the native
// `spawn_agent` tool description on both the outbound raw body (native
// passthrough) and `parsed.context.tools` (translated adapters) so the
// advertised models follow config.subagentModels instead of catalog display
// `priority`. Upstream renders that block from the five lowest-priority
// picker-visible rows (codex-rs core/src/tools/handlers/multi_agents_spec.rs
// `spawn_agent_models_description`), which was the only channel that used to
// surface the featured picks once their priorities were pinned to 0..4. The
// rewrite keeps upstream's exact text grammar; eligibility, the five-model cap
// and per-entry metadata come from effectiveSubagentRoster, so the rewritten
// list is one the active Codex can actually spawn.

const OVERRIDES_HEADER =
  "Available model overrides (optional; inherited parent model is preferred):";
const EMPTY_OVERRIDES_TEXT = "No picker-visible model overrides are currently loaded.";
// Mirrors MAX_REASONING_EFFORT_CHARS_IN_SPAWN_AGENT_DESCRIPTION
// (codex-rs core/src/tools/handlers/multi_agents_spec.rs:20); upstream truncates
// on a char boundary before marking the default.
const MAX_REASONING_EFFORT_CHARS = 64;
const MCP_NAMESPACE_PREFIX = "mcp__";
const V1_SPAWN_TOOL_FLAT_NAME = "multi_agent_v1__spawn_agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNativeSpawnAgentTool(name: unknown, namespace: unknown): boolean {
  if (name !== "spawn_agent" && name !== V1_SPAWN_TOOL_FLAT_NAME) return false;
  // An MCP server's own spawn_agent says nothing about the native surface.
  if (typeof namespace === "string" && namespace.startsWith(MCP_NAMESPACE_PREFIX)) return false;
  return true;
}

/** The exact block upstream renders for `spawn_agent_models_description`. */
export function spawnAgentModelOverridesBlock(models: readonly EffectiveSubagentModel[]): string {
  if (models.length === 0) return EMPTY_OVERRIDES_TEXT;
  const rows = models.map(model => {
    const efforts = model.efforts.map(effort => {
      const label = [...effort].slice(0, MAX_REASONING_EFFORT_CHARS).join("");
      return effort === model.defaultEffort ? `${label} (default)` : label;
    }).join(", ");
    const effortSuffix = efforts ? ` Reasoning efforts: ${efforts}.` : "";
    const tiers = (model.serviceTiers ?? []).join(", ");
    const tierSuffix = tiers ? ` Service tiers: ${tiers}.` : "";
    return `- \`${model.model}\`: ${model.description ?? ""}${effortSuffix}${tierSuffix}`;
  });
  return `${OVERRIDES_HEADER}\n${rows.join("\n")}`;
}

/**
 * Replace the advertised-overrides block inside one spawn_agent description.
 * The block opens the description in both V1 and V2 shapes; `hide_*` builds omit
 * it entirely and are left untouched. Returns undefined when nothing matched.
 */
function rewrittenSpawnAgentDescription(description: string, block: string): string | undefined {
  const headerIndex = description.indexOf(OVERRIDES_HEADER);
  if (headerIndex >= 0) {
    let end = headerIndex + OVERRIDES_HEADER.length;
    for (;;) {
      const lineEnd = description.indexOf("\n", end);
      if (lineEnd < 0) { end = description.length; break; }
      const nextLineStart = lineEnd + 1;
      if (!description.startsWith("- `", nextLineStart)) break;
      const bulletEnd = description.indexOf("\n", nextLineStart);
      end = bulletEnd < 0 ? description.length : bulletEnd;
    }
    return `${description.slice(0, headerIndex)}${block}${description.slice(end)}`;
  }
  const emptyIndex = description.indexOf(EMPTY_OVERRIDES_TEXT);
  if (emptyIndex >= 0) {
    return `${description.slice(0, emptyIndex)}${block}${description.slice(emptyIndex + EMPTY_OVERRIDES_TEXT.length)}`;
  }
  return undefined;
}

/**
 * Rewrite every native spawn_agent tool definition reachable from the raw
 * request body: the flat V2 function, V1 functions nested inside a non-MCP
 * `namespace` tool, and `additional_tools` / `tool_search_output` input items
 * (deferred V1 collaboration tools when the model supports tool search). Returns
 * the number of descriptions changed.
 */
export function rewriteSpawnAgentToolDescriptions(
  rawBody: unknown,
  models: readonly EffectiveSubagentModel[],
): number {
  if (!isRecord(rawBody)) return 0;
  const block = spawnAgentModelOverridesBlock(models);
  let rewritten = 0;
  const visit = (tool: unknown): void => {
    if (!isRecord(tool)) return;
    if (Array.isArray(tool.tools)) {
      if (typeof tool.name !== "string" || !tool.name.startsWith(MCP_NAMESPACE_PREFIX)) {
        for (const nested of tool.tools) visit(nested);
      }
    }
    if (!isNativeSpawnAgentTool(tool.name, tool.namespace) || typeof tool.description !== "string") return;
    const next = rewrittenSpawnAgentDescription(tool.description, block);
    if (next !== undefined && next !== tool.description) {
      tool.description = next;
      rewritten += 1;
    }
  };
  if (Array.isArray(rawBody.tools)) for (const tool of rawBody.tools) visit(tool);
  if (Array.isArray(rawBody.input)) {
    for (const item of rawBody.input) {
      if (
        isRecord(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
        && Array.isArray(item.tools)
      ) {
        for (const tool of item.tools) visit(tool);
      }
    }
  }
  return rewritten;
}

/**
 * Rewrite parsed `context.tools` entries in place so translated provider
 * adapters (OpenAI Chat, Anthropic, Google, Kiro, etc.) emit the same
 * configured model overrides as native Responses passthrough.
 */
export function rewriteParsedSpawnAgentTools(
  tools: OcxTool[] | undefined,
  models: readonly EffectiveSubagentModel[],
): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const block = spawnAgentModelOverridesBlock(models);
  let rewritten = 0;
  for (const tool of tools) {
    if (!isNativeSpawnAgentTool(tool.name, tool.namespace) || typeof tool.description !== "string") continue;
    const next = rewrittenSpawnAgentDescription(tool.description, block);
    if (next !== undefined && next !== tool.description) {
      tool.description = next;
      rewritten += 1;
    }
  }
  return rewritten;
}
