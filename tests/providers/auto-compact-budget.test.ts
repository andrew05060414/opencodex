import { describe, expect, test } from "bun:test";

import {
  clampAutoCompactTokenLimit,
  modelAutoCompactTokenLimitsConfigError,
} from "../../src/providers/auto-compact-budget";

describe("per-model auto-compaction budgets", () => {
  test("configuration only lowers the effective hard-limit envelope", () => {
    expect(clampAutoCompactTokenLimit(1_000)).toBe(900);
    expect(clampAutoCompactTokenLimit(1_000, 800)).toBe(800);
    expect(clampAutoCompactTokenLimit(1_000, 800, 700)).toBe(700);
    expect(clampAutoCompactTokenLimit(1_000, 800, 5_000)).toBe(800);
  });

  test("one validation contract handles config, native ids, and PATCH tombstones", () => {
    expect(modelAutoCompactTokenLimitsConfigError({ model: 64_000 })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { "gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { model: null },
      { allowTombstones: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(null, { allowTombstones: true })).toBeNull();

    for (const invalid of [
      null,
      [],
      { model: 0 },
      { model: 1.5 },
      { model: Number.MAX_SAFE_INTEGER + 1 },
      { model: null },
      JSON.parse('{"__proto__": 1000}'),
      { constructor: 1000 },
      Object.create({ inherited: 1000 }),
    ]) {
      expect(modelAutoCompactTokenLimitsConfigError(invalid)).not.toBeNull();
    }
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toContain("exact supported native model id");
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": null },
      { allowTombstones: true, requireNativeIds: true },
    )).toContain("exact supported native model id");
  });

  test("validation errors redact secret-shaped model ids", () => {
    const secret = "api_key=sk-secret-provider-key";
    const error = modelAutoCompactTokenLimitsConfigError({ [secret]: 0 });
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("sk-secret-provider-key");
  });
});


test("global catalog policy covers ordinary, combo and native windows", async () => {
  const { gatherRoutedModels, buildCatalogEntries, resolveComboCatalogMember } = await import("../../src/codex/catalog");
  const { nativeContextLimits, nativeOpenAiAutoCompactTokenLimit } = await import("../../src/codex/catalog/metadata");
  const { gatherFlightKey } = await import("../../src/codex/catalog/gather-capture");
  const { withStubbedProviderFetch } = await import("../helpers/catalog-provider-fetch");
  const config = withStubbedProviderFetch({
    port: 10100, defaultProvider: "context-policy-fixture",
    providers: { "context-policy-fixture": {
      adapter: "openai-chat", baseUrl: "https://context-policy.invalid/v1", authMode: "key", apiKey: "fixture",
      liveModels: false, models: ["unknown", "large", "small", "grok", "early"],
      modelContextWindows: { large: 1_000_000, small: 96_000, grok: 500_000, early: 1_000_000 },
      modelAutoCompactTokenLimits: { early: 100_000 },
      modelReasoningEfforts: { large: ["low", "high"] },
    } },
    combos: { policy: { targets: [{ provider: "context-policy-fixture", model: "large" }] } },
  });
  const rows = await gatherRoutedModels(config);
  const byId = new Map(rows.map(row => [row.id, row]));
  expect(byId.get("unknown")).toMatchObject({ contextWindow: 200_000, autoCompactTokenLimit: 180_000, contextWindowDefaulted: true });
  expect(byId.get("large")).toMatchObject({ contextWindow: 1_000_000, autoCompactTokenLimit: 600_000 });
  expect(byId.get("grok")?.autoCompactTokenLimit).toBe(450_000);
  expect(byId.get("small")).toMatchObject({ contextWindow: 96_000, autoCompactTokenLimit: 86_400 });
  expect(byId.get("early")?.autoCompactTokenLimit).toBe(100_000);
  expect(byId.get("policy")).toMatchObject({ contextWindow: 1_000_000, reasoningEfforts: ["low", "high"], autoCompactTokenLimit: 600_000 });
  expect(buildCatalogEntries(null, [], rows).find(row => row.slug === "combo/policy")?.auto_compact_token_limit).toBe(600_000);
  const configured = { ...config, unknownContextWindow: 240_000, autoCompactTokenLimit: 550_000 };
  expect(gatherFlightKey(configured)).not.toBe(gatherFlightKey(config));
  const updated = await gatherRoutedModels(configured);
  expect(updated.find(row => row.id === "unknown")?.contextWindow).toBe(240_000);
  expect(updated.find(row => row.id === "large")?.autoCompactTokenLimit).toBe(550_000);
  const direct = resolveComboCatalogMember({ provider: "p", model: "m" },
    new Map([["p/m", { provider: "p", id: "m", contextWindow: 1_000_000 }]]),
    new Map([["p", { adapter: "openai-chat", baseUrl: "https://fixture.invalid", modelReasoningEfforts: { m: ["low", "high"] } }]]));
  expect(direct?.reasoningEfforts).toEqual(["low", "high"]);
  expect(nativeOpenAiAutoCompactTokenLimit("gpt-5.5", nativeContextLimits({ providers: {}, autoCompactTokenLimit: 550_000 }))).toBeLessThanOrEqual(550_000);
});
