import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints, catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";
import { deriveEntry } from "../../src/codex/catalog/sync";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxProviderConfig } from "../../src/types";

/**
 * Regression coverage for the Grok CLI subscription lane (cli-chat-proxy.grok.com).
 *
 * That lane's `/v1/models` reports the DEFAULT rung of a selectable context ladder in
 * `context_window` and the whole ladder in `context_windows`. PR #7701 reports that on 2026-10-24 all
 * four rows (grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5) read:
 *
 *   `context_window: 256000, context_windows: [256000, 500000]`
 *
 * Reading only `context_window` published 256k for models the registry already carries at
 * 500k, and it could not be corrected from configuration: `clampObservedModelLimits` lets a
 * configured window LOWER the observed one and never raise it. Independent subscription-lane
 * overflow probes confirm a 500k ceiling for Grok 4.7 and build-fast in
 * devlog/_fin/260930_grok47_build_unify/010_probe-evidence.md. This is a catalog fixture,
 * not a fresh entitlement or successful long-input inference probe for every model/account.
 */

const GROK_LANE_ITEM = {
  id: "grok-4.7",
  object: "model",
  owned_by: "xAI",
  model: "grok-4.7",
  model_family: "xai",
  context_window: 256000,
  context_windows: [256000, 500000],
  auto_compact_threshold_percent: 80,
  api_backend: "responses",
};

describe("models-API context ladder", () => {
  test("a published ladder outranks the default rung beside it", () => {
    const hints = catalogHintsFromModelsApiItem("xai", GROK_LANE_ITEM);
    expect(hints.contextWindow).toBe(500000);
  });

  test("every rung is read, in any order, and the widest wins", () => {
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [500000, 256000],
    }).contextWindow).toBe(500000);
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [256000, 400000, 500000],
    }).contextWindow).toBe(500000);
  });

  test("a lane that publishes no ladder is unchanged", () => {
    const { context_windows: _ladder, ...withoutLadder } = GROK_LANE_ITEM;
    expect(catalogHintsFromModelsApiItem("xai", withoutLadder).contextWindow).toBe(256000);
  });

  test("the ladder does not outrank a recognized capability or metadata field", () => {
    // Precedence is unchanged for every field that already resolved a window: the ladder only
    // fills the slot the default rung used to fill.
    expect(catalogHintsFromModelsApiItem("hub", {
      id: "hub-row",
      capabilities: { context_length: 922000 },
      context_window: 256000,
      context_windows: [256000, 500000],
    }).contextWindow).toBe(922000);
    expect(catalogHintsFromModelsApiItem("zed", {
      id: "zed-row",
      context_length: 32768,
      context_window: 256000,
      context_windows: [256000, 500000],
    }).contextWindow).toBe(32768);
  });

  test("invalid rungs are ignored, and a ladder with none falls back to the default rung", () => {
    for (const context_windows of [
      [0, -1, 1.5, "500000", Number.MAX_SAFE_INTEGER + 1],
      [],
      "500000",
      null,
      { 0: 500000 },
    ]) {
      expect(catalogHintsFromModelsApiItem("xai", {
        ...GROK_LANE_ITEM, context_windows,
      }).contextWindow).toBe(256000);
    }
  });

  test("valid rungs survive malformed neighbors", () => {
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [null, NaN, Infinity, "500000", 0, 500000, -1, 1.5],
    }).contextWindow).toBe(500000);
  });

  for (const id of ["grok-4.5", "grok-4.6", "grok-4.7", "grok-4.7-build-fast"]) {
    test(`${id} publishes the widest rung through config projection and Codex serialization`, () => {
      const registry = getProviderRegistryEntry("xai")!;
      const provider: OcxProviderConfig = { ...registry, authMode: "oauth" };
      const hints = catalogHintsFromModelsApiItem("xai", { ...GROK_LANE_ITEM, id });
      const model = applyProviderConfigHints("xai", provider, { provider: "xai", id, ...hints });
      expect(model.contextWindow).toBe(500000);
      expect(model.reasoningEfforts).toEqual(id === "grok-4.5"
        ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]);
      expect(model.supportsFlexTier).toBe(false);
      const entry = deriveEntry(null, `xai/${id}`, "Grok", 1, model);
      expect(entry.context_window).toBe(500000);
      expect(entry.max_context_window).toBe(500000);
      expect(entry.opencodex_capability_provenance.context_window).toBe(500000);
      expect(entry.service_tiers?.some((tier: { id: string }) => tier.id === "flex") ?? false).toBe(false);
    });
  }

  test("configured windows and Context caps still lower the widest observed rung", () => {
    const id = GROK_LANE_ITEM.id;
    const provider: OcxProviderConfig = { ...getProviderRegistryEntry("xai")!, authMode: "oauth" };
    const model = { provider: "xai", id, ...catalogHintsFromModelsApiItem("xai", GROK_LANE_ITEM) };
    const lower = applyProviderConfigHints("xai", {
      ...provider, modelContextWindows: { [id]: 300000 }, modelMaxInputTokens: { [id]: 450000 },
    }, model);
    expect(lower.contextWindow).toBe(300000);
    expect(lower.maxInputTokens).toBe(300000);
    const capped = applyProviderConfigHints("xai", provider, model, 200000);
    expect(capped.contextWindow).toBe(200000);
    expect(capped.contextCapped).toBe(true);
    expect(applyProviderConfigHints("xai", {
      ...provider, modelContextWindows: { [id]: 900000 },
    }, model).contextWindow).toBe(500000);
  });

  test("inspection is bounded, so an oversized ladder cannot pad the read", () => {
    const padded = [...Array.from({ length: 8 }, () => 256000), 500000];
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: padded,
    }).contextWindow).toBe(256000);
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [500000, ...Array.from({ length: 8 }, () => 256000)],
    }).contextWindow).toBe(500000);
  });
});
