import { describe, expect, test } from "bun:test";
import {
  buildCatalogEntriesFromObservedState,
  effectiveSubagentRoster,
  MAX_SPAWN_AGENT_MODEL_OVERRIDES,
  applyFullModelPickerOrder,
  SPAWN_PRIORITY_FIELD,
} from "../../src/codex/catalog/sync";
import { multiAgentGuidanceText } from "../../src/server/responses/collaboration";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { CatalogModel } from "../../src/types";

// PX-1276: Decouple Subagent 5 recommended models from global model selector priority,
// and support unified custom ordering for native and routed models.

function nativeTemplate(): RawEntry {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    tool_mode: "code",
    multi_agent_version: "v2",
    supported_reasoning_levels: [{ effort: "high", description: "high" }],
  };
}

describe("PX-1276 Acceptance 1: subagentModels does not overwrite global catalog priorities (0..4)", () => {
  const models: CatalogModel[] = [
    { id: "gemini-2.5-flash", provider: "google", owned_by: "google" } as unknown as CatalogModel,
    { id: "claude-3-5-sonnet", provider: "anthropic", owned_by: "anthropic" } as unknown as CatalogModel,
    { id: "deepseek-v4", provider: "tyler", owned_by: "tyler" } as unknown as CatalogModel,
  ];

  test("subagentModels does not assign 0..4 priorities to routed models when no modelPickerOrder is set", () => {
    // When featured/subagentModels is empty, routed models get default priority 5.
    const entries = buildCatalogEntriesFromObservedState({
      template: nativeTemplate(),
      gptSlugs: ["gpt-5.5", "gpt-5.6-sol"],
      goModels: models,
      featured: [], // In syncCatalogModels/convergeCodexCatalog, featured is empty to prevent priority pollution
      wsEnabled: false,
      multiAgentMode: "default",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: true,
    });

    const bySlug = Object.fromEntries(entries.map(e => [e.slug as string, e.priority as number]));
    // Native models retain natural priority (not 0..4 forced by subagentModels)
    expect(bySlug["gpt-5.5"]).toBe(9);
    expect(bySlug["gpt-5.6-sol"]).toBe(4);
    // Routed models retain default priority 5, not top-pinned priority 0..4
    expect(bySlug["google/gemini-2.5-flash"]).toBe(5);
    expect(bySlug["anthropic/claude-3-5-sonnet"]).toBe(5);
    expect(bySlug["tyler/deepseek-v4"]).toBe(5);
  });
});

describe("PX-1276 Acceptance 2: spawn_agent tool description lists the 5 recommended models from subagentModels directly", () => {
  const catalog: RawEntry[] = [
    {
      slug: "gpt-5.6-sol",
      priority: 4,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "high", description: "high" }],
    },
    {
      slug: "gpt-5.5",
      priority: 1,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    },
    {
      slug: "google/gemini-2.5-flash",
      priority: 5, // Priority is default 5, NOT 0!
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "low", description: "low" }],
    },
    {
      slug: "anthropic/claude-3-5-haiku",
      priority: 5, // Priority is default 5, NOT 1!
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "low", description: "low" }],
    },
    {
      slug: "tyler/deepseek-v4",
      priority: 5,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "high", description: "high" }],
    },
    {
      slug: "jd/kimi-k3",
      priority: 5,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "high", description: "high" }],
    },
    {
      slug: "hidden-provider/hidden-model",
      priority: 5,
      visibility: "hide",
      multi_agent_version: "v2",
    },
    {
      slug: "disabled-provider/disabled-model",
      priority: 5,
      visibility: "list",
      multi_agent_version: "disabled",
    },
  ];

  test("effectiveSubagentRoster advertises configured models even when their catalog priority is >= 5", () => {
    const subagents = [
      "google/gemini-2.5-flash",
      "anthropic/claude-3-5-haiku",
      "tyler/deepseek-v4",
      "gpt-5.6-sol",
      "gpt-5.5",
    ];

    const result = effectiveSubagentRoster(subagents, "v2", catalog);
    // All 5 configured models are advertised in declared order, regardless of catalog priority
    expect(result.advertised.map(m => m.model)).toEqual(subagents);
    expect(result.candidates.map(m => m.model)).toEqual(subagents);
    expect(result.excluded).toEqual([]);
  });

  test("multiAgentGuidanceText injects all 5 configured models into spawn_agent guidance", async () => {
    const subagents = [
      "google/gemini-2.5-flash",
      "anthropic/claude-3-5-haiku",
      "tyler/deepseek-v4",
      "gpt-5.6-sol",
      "gpt-5.5",
    ];

    const parsed = {
      options: { reasoning: "high" },
      context: {
        tools: [{ name: "spawn_agent" }, { name: "send_message" }],
      },
    } as any;

    const guidance = await multiAgentGuidanceText(
      parsed,
      { subagentModels: subagents },
      {
        resolveEffectiveSubagentRoster: (models, surface) =>
          effectiveSubagentRoster(models, surface, catalog),
        collectCatalogState: () => ({ state: "fresh" }),
      },
    );

    expect(guidance).toContain('<opencodex_subagent_guidance>');
    expect(guidance).toContain('"google/gemini-2.5-flash"');
    expect(guidance).toContain('"anthropic/claude-3-5-haiku"');
    expect(guidance).toContain('"tyler/deepseek-v4"');
    expect(guidance).toContain('"gpt-5.6-sol"');
    expect(guidance).toContain('"gpt-5.5"');
  });

  test("6th configured model is excluded with outside_display_limit", () => {
    const sixModels = [
      "google/gemini-2.5-flash",
      "anthropic/claude-3-5-haiku",
      "tyler/deepseek-v4",
      "gpt-5.6-sol",
      "gpt-5.5",
      "jd/kimi-k3",
    ];

    const result = effectiveSubagentRoster(sixModels, "v2", catalog);
    expect(result.advertised.map(m => m.model)).toEqual(sixModels.slice(0, 5));
    expect(result.excluded).toEqual([{
      configured: "jd/kimi-k3",
      catalogModel: "jd/kimi-k3",
      reason: "outside_display_limit",
    }]);
  });

  test("invalid configured models are properly classified in excluded", () => {
    const configured = [
      "google/gemini-2.5-flash",
      "nonexistent/model",
      "hidden-provider/hidden-model",
      "disabled-provider/disabled-model",
    ];

    const result = effectiveSubagentRoster(configured, "v2", catalog);
    expect(result.advertised.map(m => m.model)).toEqual(["google/gemini-2.5-flash"]);
    expect(result.excluded).toEqual([
      { configured: "nonexistent/model", reason: "missing_catalog_entry" },
      { configured: "hidden-provider/hidden-model", catalogModel: "hidden-provider/hidden-model", reason: "picker_hidden" },
      { configured: "disabled-provider/disabled-model", catalogModel: "disabled-provider/disabled-model", reason: "surface_incompatible" },
    ]);
  });
});

describe("PX-1276 Acceptance 3: modelPickerOrder accommodates native and routed models uniformly", () => {
  test("mix of native models and routed models sorts exactly in declared order", () => {
    const rows: RawEntry[] = [
      { slug: "opencode-go/glm-5.3", priority: 5, visibility: "list" },
      { slug: "gpt-5.6-sol", priority: 4, visibility: "list" },
      { slug: "gpt-6-astra", priority: 0, visibility: "list" },
      { slug: "anthropic/claude-3-5-sonnet", priority: 5, visibility: "list" },
      { slug: "gpt-5.5", priority: 1, visibility: "list" },
    ];

    // Mixed order: native and routed models intertwined
    const order = [
      "anthropic/claude-3-5-sonnet",
      "gpt-5.6-sol",
      "opencode-go/glm-5.3",
      "gpt-6-astra",
    ];

    applyFullModelPickerOrder(rows, order);

    const sorted = [...rows].sort((a, b) => Number(a.priority) - Number(b.priority));
    expect(sorted.map(r => r.slug)).toEqual([
      "anthropic/claude-3-5-sonnet",
      "gpt-5.6-sol",
      "opencode-go/glm-5.3",
      "gpt-6-astra",
      "gpt-5.5", // unlisted model placed after ordered models
    ]);

    // Priorities are sequential 0, 1, 2, 3 for ordered models
    expect(sorted[0]!.priority).toBe(0);
    expect(sorted[1]!.priority).toBe(1);
    expect(sorted[2]!.priority).toBe(2);
    expect(sorted[3]!.priority).toBe(3);
    // Unlisted model priority is order.length + natural
    expect(sorted[4]!.priority).toBeGreaterThanOrEqual(order.length);
  });

  test("ordering is idempotent and reproducible across repeated applications", () => {
    const rows: RawEntry[] = [
      { slug: "tyler/deepseek-v4", priority: 5 },
      { slug: "gpt-5.6-sol", priority: 4 },
      { slug: "google/gemini-2.5-flash", priority: 5 },
    ];
    const order = ["gpt-5.6-sol", "google/gemini-2.5-flash", "tyler/deepseek-v4"];

    applyFullModelPickerOrder(rows, order);
    const firstPass = structuredClone(rows);

    applyFullModelPickerOrder(rows, order);
    expect(rows).toEqual(firstPass);
  });
});

