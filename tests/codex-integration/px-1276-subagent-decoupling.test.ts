// Holds INV-AGENT-01 from structure/overview.md; keep the id here if this file is split or renamed.
import { describe, expect, test } from "bun:test";
import {
  buildCatalogEntriesFromObservedState,
  effectiveSubagentRoster,
  MAX_SPAWN_AGENT_MODEL_OVERRIDES,
  applyFullModelPickerOrder,
  SPAWN_PRIORITY_FIELD,
} from "../../src/codex/catalog/sync";
import { multiAgentGuidanceText, rewriteSpawnAgentToolModelOverrides } from "../../src/server/responses/collaboration";
import {
  rewriteSpawnAgentToolDescriptions,
  spawnAgentModelOverridesBlock,
} from "../../src/server/responses/spawn-agent-model-overrides";
import { parseRequest } from "../../src/responses/parser";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { CatalogModel, OcxProviderConfig } from "../../src/types";

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


// INV-AGENT-01: the outbound spawn_agent tool description advertises the configured
// subagentModels on both surfaces, regardless of catalog display priority.
describe("PX-1276 rework: spawn_agent tool description follows subagentModels on the wire", () => {
  const OVERRIDES_HEADER =
    "Available model overrides (optional; inherited parent model is preferred):";
  const catalog: RawEntry[] = [
    {
      slug: "google/gemini-2.5-flash",
      description: "Routed via opencodex → google gemini-2.5-flash",
      priority: 50,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      default_reasoning_level: "high",
    },
    {
      slug: "tyler/deepseek-v4",
      description: "Routed via opencodex → tyler deepseek-v4",
      priority: 51,
      visibility: "list",
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "medium" }],
      service_tiers: [{ id: "ultrafast", description: "fast" }],
    },
    {
      slug: "gpt-a", priority: 0, visibility: "list", multi_agent_version: "v2",
      description: "native a", supported_reasoning_levels: [{ effort: "low" }],
    },
    {
      slug: "gpt-b", priority: 1, visibility: "list", multi_agent_version: "v2",
      description: "native b", supported_reasoning_levels: [{ effort: "low" }],
    },
  ];
  const subagents = ["google/gemini-2.5-flash", "tyler/deepseek-v4"];
  const upstreamBlock = `${OVERRIDES_HEADER}\n- \`gpt-a\`: native a Reasoning efforts: low.\n- \`gpt-b\`: native b Reasoning efforts: low.`;

  const parsedFor = (tools: unknown[], rawBody: Record<string, unknown>) =>
    ({ context: { tools }, _rawBody: rawBody }) as never;

  test("V2 flat spawn_agent tool description is rewritten to the configured picks", async () => {
    const rawBody = {
      model: "gpt-a",
      tools: [
        { type: "function", name: "exec", description: "Run JavaScript" },
        {
          type: "function",
          name: "spawn_agent",
          description: `\n        ${upstreamBlock}\n        Spawns an agent to work on the specified task.`,
          parameters: { type: "object" },
        },
      ],
    };
    const rewritten = await rewriteSpawnAgentToolModelOverrides(
      parsedFor([{ name: "spawn_agent" }], rawBody),
      { subagentModels: subagents },
      {
        collectCatalogState: () => ({ state: "fresh" }),
        resolveEffectiveSubagentRoster: (models, surface) =>
          effectiveSubagentRoster(models, surface, catalog),
      },
    );
    expect(rewritten).toBe(1);
    const description = (rawBody.tools[1] as { description: string }).description;
    // The wire description Codex forwards now advertises the configured picks,
    // not the two lowest-priority native rows upstream rendered.
    expect(description).toContain(OVERRIDES_HEADER);
    expect(description).toContain("- `google/gemini-2.5-flash`: Routed via opencodex → google gemini-2.5-flash Reasoning efforts: low, high (default).");
    expect(description).toContain("- `tyler/deepseek-v4`: Routed via opencodex → tyler deepseek-v4 Reasoning efforts: medium. Service tiers: ultrafast.");
    expect(description).not.toContain("`gpt-a`");
    expect(description).not.toContain("`gpt-b`");
    expect(description).toContain("Spawns an agent to work on the specified task.");
    expect((rawBody.tools[0] as { description: string }).description).toBe("Run JavaScript");
  });

  test("V1 namespaced spawn_agent inside a namespace tool is rewritten", async () => {
    const rawBody = {
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: `\n        ${upstreamBlock}\n        Spawn a sub-agent for a well-scoped task.`,
            },
          ],
        },
        {
          type: "namespace",
          name: "mcp__other",
          tools: [{ type: "function", name: "spawn_agent", description: upstreamBlock }],
        },
      ],
    };
    const rewritten = await rewriteSpawnAgentToolModelOverrides(
      parsedFor([
        { name: "spawn_agent", namespace: "agents" },
        { name: "send_input", namespace: "agents" },
      ], rawBody),
      { subagentModels: subagents },
      {
        collectCatalogState: () => ({ state: "fresh" }),
        resolveEffectiveSubagentRoster: (models, surface) =>
          effectiveSubagentRoster(models, surface, catalog),
      },
    );
    expect(rewritten).toBe(1);
    const namespaces = rawBody.tools as Array<{ name: string; tools: Array<{ description: string }> }>;
    expect(namespaces[0]!.tools[0]!.description).toContain("- `google/gemini-2.5-flash`");
    expect(namespaces[0]!.tools[0]!.description).toContain("Spawn a sub-agent for a well-scoped task.");
    // An MCP server's own spawn_agent is not the native surface.
    expect(namespaces[1]!.tools[0]!.description).toBe(upstreamBlock);
  });

  test("stale or unknown catalog state leaves the native description untouched", async () => {
    for (const state of ["stale", "unknown"] as const) {
      const rawBody = {
        tools: [{
          type: "function", name: "spawn_agent",
          description: `${upstreamBlock}\n        Spawns an agent.`,
        }],
      };
      const rewritten = await rewriteSpawnAgentToolModelOverrides(
        parsedFor([{ name: "spawn_agent" }], rawBody),
        { subagentModels: subagents },
        {
          collectCatalogState: () => ({ state }),
          resolveEffectiveSubagentRoster: (models, surface) =>
            effectiveSubagentRoster(models, surface, catalog),
        },
      );
      expect(rewritten).toBe(0);
      expect(rawBody.tools[0]!.description).toContain("`gpt-a`");
    }
  });

  test("no collaboration surface, no configured picks, or guidance disabled means no rewrite", async () => {
    const rawBody = () => ({
      tools: [{
        type: "function", name: "spawn_agent",
        description: `${upstreamBlock}\n        Spawns an agent.`,
      }],
    });
    const deps = {
      collectCatalogState: () => ({ state: "fresh" as const }),
      resolveEffectiveSubagentRoster: (models: readonly string[], surface: "v1" | "v2") =>
        effectiveSubagentRoster(models, surface, catalog),
    };
    // no collab surface
    const noSurface = rawBody();
    expect(await rewriteSpawnAgentToolModelOverrides(
      parsedFor([{ name: "exec" }], noSurface), { subagentModels: subagents }, deps)).toBe(0);
    // nothing configured
    const unconfigured = rawBody();
    expect(await rewriteSpawnAgentToolModelOverrides(
      parsedFor([{ name: "spawn_agent" }], unconfigured), {}, deps)).toBe(0);
    // operator disabled multi-agent guidance entirely
    const disabled = rawBody();
    expect(await rewriteSpawnAgentToolModelOverrides(
      parsedFor([{ name: "spawn_agent" }], disabled),
      { multiAgentGuidanceEnabled: false, subagentModels: subagents }, deps)).toBe(0);
    expect(noSurface.tools[0]!.description).toContain("`gpt-a`");
    expect(unconfigured.tools[0]!.description).toContain("`gpt-a`");
    expect(disabled.tools[0]!.description).toContain("`gpt-a`");
  });

  test("hide-style descriptions without the overrides block are left untouched", () => {
    const rawBody = {
      tools: [{
        type: "function", name: "spawn_agent",
        description: "\n        Spawns an agent to work on the specified task.",
      }],
    };
    const rewritten = rewriteSpawnAgentToolDescriptions(rawBody, [
      { model: "x/y", efforts: [] },
    ]);
    expect(rewritten).toBe(0);
    expect(rawBody.tools[0]!.description).toBe("\n        Spawns an agent to work on the specified task.");
  });

  test("empty advertised roster renders the upstream empty marker", () => {
    expect(spawnAgentModelOverridesBlock([]))
      .toBe("No picker-visible model overrides are currently loaded.");
  });

  const chatProvider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://chat-gateway.example.invalid/v1",
    apiKey: "test-key",
  };
  const routedDeps = {
    collectCatalogState: () => ({ state: "fresh" as const }),
    resolveEffectiveSubagentRoster: (models: readonly string[], surface: "v1" | "v2") =>
      effectiveSubagentRoster(models, surface, catalog),
  };

  test("V2 flat spawn_agent rewrite reaches translated adapter outbound request body", async () => {
    const parsed = parseRequest({
      model: "tyler/deepseek-v4",
      input: [{ role: "user", content: "Delegate a task." }],
      tools: [
        {
          type: "function",
          name: "exec",
          description: "Run JavaScript",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "spawn_agent",
          description: `\n        ${upstreamBlock}\n        Spawns an agent to work on the specified task.`,
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const rewritten = await rewriteSpawnAgentToolModelOverrides(
      parsed,
      { subagentModels: subagents },
      routedDeps,
    );
    expect(rewritten).toBe(1);
    const req = createOpenAIChatAdapter(chatProvider).buildRequest(parsed) as { body: string };
    const body = JSON.parse(req.body) as {
      tools: Array<{ function: { name: string; description?: string } }>;
    };
    const spawnTool = body.tools.find(t => t.function.name === "spawn_agent");
    expect(spawnTool?.function.description).toContain(OVERRIDES_HEADER);
    expect(spawnTool?.function.description).toContain(
      "- `google/gemini-2.5-flash`: Routed via opencodex → google gemini-2.5-flash Reasoning efforts: low, high (default).",
    );
    expect(spawnTool?.function.description).toContain(
      "- `tyler/deepseek-v4`: Routed via opencodex → tyler deepseek-v4 Reasoning efforts: medium. Service tiers: ultrafast.",
    );
    expect(spawnTool?.function.description).not.toContain("`gpt-a`");
    expect(spawnTool?.function.description).not.toContain("`gpt-b`");
    expect(spawnTool?.function.description).toContain("Spawns an agent to work on the specified task.");
    expect(body.tools.find(t => t.function.name === "exec")?.function.description).toBe("Run JavaScript");
  });

  test("V1 namespaced spawn_agent rewrite reaches translated adapter outbound request body", async () => {
    const parsed = parseRequest({
      model: "tyler/deepseek-v4",
      input: [{ role: "user", content: "Delegate a task." }],
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: `\n        ${upstreamBlock}\n        Spawn a sub-agent for a well-scoped task.`,
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        {
          type: "namespace",
          name: "mcp__other",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: upstreamBlock,
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    });
    const rewritten = await rewriteSpawnAgentToolModelOverrides(
      parsed,
      { subagentModels: subagents },
      routedDeps,
    );
    expect(rewritten).toBe(1);
    const req = createOpenAIChatAdapter(chatProvider).buildRequest(parsed) as { body: string };
    const body = JSON.parse(req.body) as {
      tools: Array<{ function: { name: string; description?: string } }>;
    };
    const v1Spawn = body.tools.find(t => t.function.name === "multi_agent_v1__spawn_agent");
    expect(v1Spawn?.function.description).toContain("- `google/gemini-2.5-flash`");
    expect(v1Spawn?.function.description).toContain("Spawn a sub-agent for a well-scoped task.");
    expect(v1Spawn?.function.description).not.toContain("`gpt-a`");
    const mcpSpawn = body.tools.find(t => t.function.name === "mcp__other__spawn_agent");
    expect(mcpSpawn?.function.description).toBe(upstreamBlock);
  });

  test("V1 deferred spawn_agent via tool_search_output rewrites both _rawBody and translated adapter body", async () => {
    const parsed = parseRequest({
      model: "gpt-6-astra",
      tools: [
        { type: "tool_search", execution: "client" },
      ],
      input: [
        { role: "user", content: "Search and spawn a sub-agent." },
        {
          type: "tool_search_output",
          call_id: "call_ts_1",
          status: "completed",
          tools: [
            {
              type: "namespace",
              name: "multi_agent_v1",
              tools: [
                {
                  type: "function",
                  name: "spawn_agent",
                  description: `\n        ${upstreamBlock}\n        Spawn a sub-agent for a well-scoped task.`,
                  parameters: { type: "object", properties: {} },
                },
                {
                  type: "function",
                  name: "send_input",
                  description: "Send input to an agent.",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
            {
              type: "namespace",
              name: "mcp__other",
              tools: [
                {
                  type: "function",
                  name: "spawn_agent",
                  description: upstreamBlock,
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
    });
    const rewritten = await rewriteSpawnAgentToolModelOverrides(
      parsed,
      { subagentModels: subagents },
      routedDeps,
    );
    expect(rewritten).toBe(1);

    // Native passthrough reads parsed._rawBody directly.
    const rawSearchOutput = (parsed._rawBody as {
      input: Array<{ type?: string; tools?: Array<{ name: string; tools: Array<{ name: string; description: string }> }> }>;
    }).input.find(item => item.type === "tool_search_output");
    const rawV1Spawn = rawSearchOutput?.tools?.find(ns => ns.name === "multi_agent_v1")
      ?.tools.find(t => t.name === "spawn_agent");
    expect(rawV1Spawn?.description).toContain("- `google/gemini-2.5-flash`");
    expect(rawV1Spawn?.description).not.toContain("`gpt-a`");
    expect(rawV1Spawn?.description).toContain("Spawn a sub-agent for a well-scoped task.");
    const rawMcpSpawn = rawSearchOutput?.tools?.find(ns => ns.name === "mcp__other")
      ?.tools.find(t => t.name === "spawn_agent");
    expect(rawMcpSpawn?.description).toBe(upstreamBlock);

    // Translated adapters read parsed.context.tools.
    const req = createOpenAIChatAdapter(chatProvider).buildRequest(parsed) as { body: string };
    const body = JSON.parse(req.body) as {
      tools: Array<{ function: { name: string; description?: string } }>;
    };
    const v1Spawn = body.tools.find(t => t.function.name === "multi_agent_v1__spawn_agent");
    expect(v1Spawn?.function.description).toContain("- `google/gemini-2.5-flash`");
    expect(v1Spawn?.function.description).not.toContain("`gpt-a`");
    expect(v1Spawn?.function.description).toContain("Spawn a sub-agent for a well-scoped task.");
    const mcpSpawn = body.tools.find(t => t.function.name === "mcp__other__spawn_agent");
    expect(mcpSpawn?.function.description).toBe(upstreamBlock);
  });
});
