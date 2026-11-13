import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels, resolveAntigravityEffortWireModel } from "../../../src/providers/antigravity-models";
import { readAntigravityWireSnapshot, writeAntigravityWireSnapshot } from "../../../src/providers/antigravity-wire-snapshot";
import { antigravityUserAgentForWireModel, ANTIGRAVITY_CLI_REQUEST_UA, ANTIGRAVITY_REQUEST_UA } from "../../../src/adapters/google-antigravity-wire";
import { antigravityEffortFamilyIds, collapseAntigravityPublicModels } from "../../../src/providers/antigravity-effort-families";
import { captureModelCacheGeneration, clearModelCache } from "../../../src/codex/model-cache";
import { gatherRoutedModels } from "../../../src/codex/catalog";
import type { OcxConfig } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let testHome: string;
beforeEach(() => { testHome = mkdtempSync(join(tmpdir(), "ocx-agy-xhigh-")); process.env.OPENCODEX_HOME = testHome; });
afterEach(() => {
  registerAntigravityDiscoveredWireModels(baseUrl, []);
  clearModelCache(provider);
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(testHome);
});

const provider = "google-antigravity";
const baseUrl = "https://antigravity-xhigh.example.test";
const hydrogen = "gemini-4-hydrogen";
function payload(base: string, tiers: readonly string[]) {
  const ids = tiers.map(tier => `${base}-${tier}`);
  return { models: Object.fromEntries(ids.map(id => [id, { maxTokens: 1_048_576, supportsImages: true }])),
    agentModelSorts: [{ groups: [{ modelIds: ids }] }] };
}

test("a complete family with an xhigh row collapses into one four-tier model", () => {
  const rows = parseAntigravityAvailableModels(payload(hydrogen, ["xhigh", "high", "low", "medium"]))!;
  expect(rows.map(row => row.id)).toEqual([hydrogen]);
  expect(rows[0]!.effortWireModelIds).toEqual({
    low: `${hydrogen}-low`, medium: `${hydrogen}-medium`, high: `${hydrogen}-high`, xhigh: `${hydrogen}-xhigh`,
  });
  registerAntigravityDiscoveredWireModels(baseUrl, rows);
  for (const tier of ["low", "medium", "high", "xhigh"]) {
    expect(resolveAntigravityEffortWireModel(hydrogen, tier, baseUrl)).toEqual({ wireModelId: `${hydrogen}-${tier}` });
  }
  for (const effort of ["max", "ultra"]) {
    expect(resolveAntigravityEffortWireModel(hydrogen, effort, baseUrl)).toEqual({ wireModelId: `${hydrogen}-xhigh` });
  }
  expect(resolveAntigravityEffortWireModel(hydrogen, undefined, baseUrl)).toEqual({ wireModelId: `${hydrogen}-medium` });
  expect(resolveAntigravityEffortWireModel(hydrogen, "xhigh", baseUrl, { includeThoughts: true }))
    .toEqual({ wireModelId: `${hydrogen}-xhigh` });
});

test("the extra-high spelling is the same xhigh tier", () => {
  const rows = parseAntigravityAvailableModels(payload("gemini-4-neon", ["low", "medium", "high", "extra-high"]))!;
  expect(rows.map(row => row.id)).toEqual(["gemini-4-neon"]);
  expect(rows[0]!.effortWireModelIds?.xhigh).toBe("gemini-4-neon-extra-high");
  registerAntigravityDiscoveredWireModels(baseUrl, rows);
  expect(resolveAntigravityEffortWireModel("gemini-4-neon", "xhigh", baseUrl)).toEqual({ wireModelId: "gemini-4-neon-extra-high" });
});

test("xhigh never completes a partial family", () => {
  const rows = parseAntigravityAvailableModels(payload(hydrogen, ["low", "high", "xhigh"]))!;
  expect(rows.map(row => row.id)).toEqual([`${hydrogen}-low`, `${hydrogen}-high`, `${hydrogen}-xhigh`]);
  expect(rows.every(row => row.effortWireModelIds === undefined)).toBe(true);
});

test("three-tier families still clamp xhigh, max and ultra to high", () => {
  registerAntigravityDiscoveredWireModels(baseUrl, parseAntigravityAvailableModels(payload("future-flash", ["low", "medium", "high"]))!);
  for (const effort of ["xhigh", "max", "ultra"]) {
    expect(resolveAntigravityEffortWireModel("future-flash", effort, baseUrl)).toEqual({ wireModelId: "future-flash-high" });
  }
});

test("a saved standalone xhigh selection still sends the xhigh wire id", () => {
  registerAntigravityDiscoveredWireModels(baseUrl, parseAntigravityAvailableModels(payload(hydrogen, ["low", "medium", "high", "xhigh"]))!);
  expect(resolveAntigravityEffortWireModel(`${hydrogen}-xhigh`, undefined, baseUrl)).toEqual({ wireModelId: `${hydrogen}-xhigh` });
  expect(resolveAntigravityEffortWireModel(`${hydrogen}-xhigh`, "low", baseUrl)).toEqual({ wireModelId: `${hydrogen}-xhigh` });
});

test("the durable snapshot keeps xhigh and still reads three-tier snapshots", () => {
  registerAntigravityDiscoveredWireModels(baseUrl, parseAntigravityAvailableModels(payload(hydrogen, ["low", "medium", "high", "xhigh"]))!,
    { provider, cacheGeneration: captureModelCacheGeneration(provider) });
  expect(readAntigravityWireSnapshot(baseUrl)?.families[hydrogen]).toEqual({
    low: `${hydrogen}-low`, medium: `${hydrogen}-medium`, high: `${hydrogen}-high`, xhigh: `${hydrogen}-xhigh`,
  });

  const restartedUrl = "https://antigravity-xhigh-restart.example.test";
  writeAntigravityWireSnapshot(restartedUrl, { version: 1, provider, families: {
    [hydrogen]: { low: `${hydrogen}-low`, medium: `${hydrogen}-medium`, high: `${hydrogen}-high`, xhigh: `${hydrogen}-xhigh` },
    "gemini-4-argon": { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" },
  } });
  expect(resolveAntigravityEffortWireModel(hydrogen, "xhigh", restartedUrl)).toEqual({ wireModelId: `${hydrogen}-xhigh` });
  expect(resolveAntigravityEffortWireModel("gemini-4-argon", "xhigh", restartedUrl)).toEqual({ wireModelId: "gemini-4-argon-high" });
  registerAntigravityDiscoveredWireModels(restartedUrl, []);
});

test("a snapshot xhigh entry that names another model fails closed", () => {
  expect(() => writeAntigravityWireSnapshot(baseUrl, { version: 1, provider, families: {
    [hydrogen]: { low: `${hydrogen}-low`, medium: `${hydrogen}-medium`, high: `${hydrogen}-high`, xhigh: "gemini-4-argon-high" },
  } })).toThrow();
});

test("xhigh wire ids ride the CLI User-Agent like every Gemini 4 tier", () => {
  for (const wire of [`${hydrogen}-xhigh`, `${hydrogen}-extra-high`, `${hydrogen}-high`, hydrogen]) {
    expect(antigravityUserAgentForWireModel(wire)).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
  }
  expect(antigravityUserAgentForWireModel("claude-opus-5-5-high")).toBe(ANTIGRAVITY_REQUEST_UA);
});

test("the public list hides a retained standalone xhigh row behind its family", () => {
  const family = { id: hydrogen, provider, antigravityEffortWireModelIds: {
    low: `${hydrogen}-low`, medium: `${hydrogen}-medium`, high: `${hydrogen}-high`, xhigh: `${hydrogen}-xhigh` } };
  expect(antigravityEffortFamilyIds(family)).toEqual(["low", "medium", "high", "xhigh"].map(tier => `${hydrogen}-${tier}`));
  const retained = { id: `${hydrogen}-xhigh`, provider };
  expect(collapseAntigravityPublicModels([family, retained]).map(row => row.id)).toEqual([hydrogen]);
});

test("the catalog advertises the xhigh rung for a four-tier family", async () => {
  globalThis.fetch = (async () => Response.json(payload(hydrogen, ["low", "medium", "high", "xhigh"]))) as typeof fetch;
  const config: OcxConfig = { port: 0, defaultProvider: provider, providers: { [provider]: {
    adapter: "google", authMode: "key", apiKey: "fixture-token", baseUrl, googleMode: "cloud-code-assist",
    liveModels: true, project: "fixture-project",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
  } } };
  const rows = await gatherRoutedModels(config);
  expect(rows.map(row => row.id)).toEqual([hydrogen]);
  expect(rows[0]).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" });
});
