import { expect, test } from "bun:test";
import { summarizeUsage } from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { pickerIdentityCoverage, customPickerRows, normalizePickerIds, pickerSnapshotSignature, movePickerBefore, stepPickerOrder, isModelPickerUsage, isPickerOrderSaved, isPickerOrderSettings, modelPickerOrder, modelPickerOrderMode } from "../src/model-picker-order";

const models = ["zeta/beta", "alpha/zeta", "alpha/alpha"];

test("presets save deterministic model/provider ordering and Default clears", () => {
  expect(modelPickerOrder("alphabetical", models)).toEqual(["alpha/alpha", "zeta/beta", "alpha/zeta"]);
  expect(modelPickerOrder("provider", [...models, models[0]!])).toEqual(["alpha/alpha", "alpha/zeta", "zeta/beta"]);
  expect(modelPickerOrder("default", models)).toBeNull();
  expect(models).toEqual(["zeta/beta", "alpha/zeta", "alpha/alpha"]);
});
test("Most used counts only requested identities, ignoring representative resolved targets", () => {
  expect(modelPickerOrder("most-used", models, [
    { provider: "alpha", model: "zeta", resolvedModel: "alpha", requests: 4 },
    { provider: "alpha", model: "alpha/zeta", requests: 4 },
    { provider: "zeta", model: "missing", resolvedModel: "beta", requests: 3 },
  ])).toEqual(["alpha/zeta", "alpha/alpha", "zeta/beta"]);
  expect(modelPickerOrder("most-used", models, [])).toEqual(["alpha/alpha", "alpha/zeta", "zeta/beta"]);
});
test("raw slash-bearing ids resolve through observed canonical identities, never guessed namespaces", () => {
  const available = ["vendor/team-model", "vendor/other", "team/model"];
  expect(modelPickerOrder("most-used", available, [{ provider: "vendor", model: "team/model", requests: 9 }],
    [{ provider: "vendor", id: "team/model", namespaced: "vendor/team-model" }]))
    .toEqual(["vendor/team-model", "team/model", "vendor/other"]);
  expect(modelPickerOrder("most-used", available, [{ provider: "vendor", model: "team/model", requests: 9 }]))
    .toEqual(["team/model", "vendor/other", "vendor/team-model"]);
});
test("ambiguous raw identity does not choose a catalog row", () => {
  expect(modelPickerOrder("most-used", ["p/a", "p/b"], [{ provider: "p", model: "upstream", resolvedModel: "b", requests: 9 }], [
    { provider: "p", id: "upstream", namespaced: "p/a" }, { provider: "p", id: "upstream", namespaced: "p/b" },
  ])).toEqual(["p/a", "p/b"]);
});
test("saved mode is snapshot provenance across roster drift; unmodeled native+routed orders stay Custom", () => {
  expect(modelPickerOrderMode(models, [])).toBe("default");
  expect(modelPickerOrderMode(models, ["alpha/alpha", "alpha/zeta", "zeta/beta"])).toBe("provider");
  expect(modelPickerOrderMode([...models, "new/model"], ["gone/model", "alpha/zeta"], "most-used")).toBe("most-used");
  expect(modelPickerOrderMode([...models, "gpt-5.5"], ["gpt-5.5", "alpha/zeta"], "most-used")).toBe("most-used");
  expect(modelPickerOrderMode([...models, "gpt-5.5"], ["gpt-5.5", "alpha/zeta"], null)).toBe("custom");
  expect(modelPickerOrderMode(models, ["alpha/zeta"])).toBe("custom");
});
test("transport guards reject missing/malformed state instead of synthesizing a successful reset", () => {
  expect(isPickerOrderSettings({ pickerAvailable: [], pickerOrder: [], pickerOrderMode: null })).toBe(true);
  for (const value of [undefined, null, {}, { pickerOrder: [] }, { pickerOrder: [], pickerOrderMode: "default" }]) {
    expect(isPickerOrderSaved(value)).toBe(false);
  }
  expect(isModelPickerUsage([])).toBe(true);
  expect(isModelPickerUsage([{ provider: "p", model: "a", requests: -1 }])).toBe(false);
  expect(isModelPickerUsage([{ provider: "p", model: "a", requests: Infinity }])).toBe(false);
});


test("encoded collisions cannot attribute usage to an unproven winner", () => {
  expect(modelPickerOrder("most-used", ["p/a", "p/team-model"],
    [{ provider: "p", model: "team/model", requests: 100 }], [
      { provider: "p", id: "team/model", namespaced: "p/team-model" },
      { provider: "p", id: "team-model", namespaced: "p/team-model" },
    ])).toEqual(["p/a", "p/team-model"]);
});


test("real mixed-resolved usage summary never credits an entire legacy bucket to its representative", () => {
  const now = Date.UTC(2026, 8, 7, 12);
  const entries: PersistedUsageEntry[] = Array.from({ length: 15 }, (_, index) => ({
    requestId: `picker-mixed-${index}`, timestamp: now - 15 + index,
    provider: "p", model: index < 10 ? "legacy" : "a",
    resolvedModel: index === 0 ? "b" : index < 10 ? "c" : "a",
    status: 200, durationMs: 10, usageStatus: "unreported",
  }));
  const summary = summarizeUsage(entries, "all", now);
  const legacy = summary.models.find(row => row.model === "legacy")!;
  expect(legacy.requests).toBe(10);
  expect(legacy.resolvedModel).toBe("b");
  expect(summary.models.find(row => row.model === "a")?.requests).toBe(5);
  // Only a's five requested-identity calls are attributable to current candidates.
  // b/c remain tied at zero; the first representative b does not inherit ten calls.
  expect(modelPickerOrder("most-used", ["p/c", "p/b", "p/a"], summary.models))
    .toEqual(["p/a", "p/b", "p/c"]);
});


test("Custom normalizes exact canonical/native names before non-native provider/raw aliases, without native guesses", () => {
  const identities = [
    { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true },
    { provider: "combo", id: "my-fast", namespaced: "fast" },
    { provider: "p", id: "team/model", namespaced: "p/team-model" },
    { provider: "p", id: "collision", namespaced: "p/a" },
    { provider: "p", id: "collision", namespaced: "p/b" },
  ];
  expect(normalizePickerIds(["p/team/model", "p/collision", "native", "openai/gpt-5.6-sol", "GPT-5.6-SOL", "gpt-5.6-sol", "combo/my-fast", "p/team-model"],
    ["gpt-5.6-sol", "fast", "p/team-model", "p/a", "p/b"], identities)).toEqual(["p/team-model", "gpt-5.6-sol", "fast"]);
  expect(normalizePickerIds(["p/team/model"], ["p/team/model", "p/team-model"], identities)).toEqual(["p/team/model"]);
});

test("saved order wins without a fixed featured prefix, newcomers follow GET candidate order", () => {
  expect(customPickerRows({ pickerAvailable: ["gpt-5.6-sol", "fast", "p/new", "p/b", "p/a", "p/top", "p/b"],
    chosen: ["native", "p/top", "p/a", "missing/model"], pickerOrder: ["gone/model", "p/b", "fast", "gpt-5.6-sol", "p/a"], pickerOrderMode: null,
  }, [
    { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true },
    { provider: "combo", id: "my-fast", namespaced: "fast" },
    ...["new", "b", "a", "top"].map(id => ({ provider: "p", id, namespaced: `p/${id}` })),
  ]))
    .toEqual({ fixed: [], order: ["p/b", "fast", "gpt-5.6-sol", "p/a", "p/new", "p/top"] });
  expect(customPickerRows({ pickerAvailable: [], chosen: [], pickerOrder: [], pickerOrderMode: null }, []))
    .toEqual({ fixed: [], order: [] });
});

test("unknown chosen stays editable; malformed supplied chosen rejects; mixed native+combo+routed requires explicit native/catalog identity", () => {
  const settings = { pickerAvailable: ["gpt-5.6-sol", "fast", "p/a"], pickerOrder: ["p/a", "fast", "gpt-5.6-sol"], pickerOrderMode: null };
  const nativeSol = { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true };
  const comboFast = { provider: "combo", id: "my-fast", namespaced: "fast" };
  const a = { provider: "p", id: "a", namespaced: "p/a" };
  expect(isPickerOrderSettings(settings)).toBe(true);
  expect(customPickerRows(settings, [])).toBeNull();
  expect(customPickerRows(settings, [nativeSol, a])).toBeNull();
  expect(customPickerRows(settings, [comboFast, a])).toBeNull();
  expect(customPickerRows(settings, [nativeSol, comboFast, a])).toEqual({ fixed: [], order: ["p/a", "fast", "gpt-5.6-sol"] });
  expect(customPickerRows({ ...settings, chosen: [] }, [nativeSol, comboFast, a])).toEqual({ fixed: [], order: ["p/a", "fast", "gpt-5.6-sol"] });
  expect(customPickerRows({ pickerAvailable: ["gpt-5.6-sol"], pickerOrder: ["gpt-5.6-sol"], pickerOrderMode: null }, [nativeSol]))
    .toEqual({ fixed: [], order: ["gpt-5.6-sol"] });
  expect(pickerIdentityCoverage(["gpt-5.6-sol", "openai/gpt-5.6-sol", "fast", "p/a"], [
    nativeSol,
    { provider: "openai", id: "gpt-5.6-sol", namespaced: "openai/gpt-5.6-sol" },
    comboFast,
    a,
  ])).toBe(true);
  expect(pickerIdentityCoverage(["gpt-5.6-sol"], [nativeSol, { provider: "combo", id: "c1", namespaced: "gpt-5.6-sol" }])).toBe(false);
  expect(settings.pickerOrder).toEqual(["p/a", "fast", "gpt-5.6-sol"]);
  for (const chosen of [null, undefined, "p/a", [2]]) expect(isPickerOrderSettings({ ...settings, chosen })).toBe(false);
  expect(isPickerOrderSettings({ ...settings, chosen: [] })).toBe(true);
});

test("snapshot binds base, activation, candidate sequence, chosen, saved order and provenance", () => {
  const settings = { pickerAvailable: ["p/b", "p/a"], chosen: [], pickerOrder: ["p/a"], pickerOrderMode: null };
  const expected = '["/a",7,["p/b","p/a"],[],["p/a"],null]';
  expect(pickerSnapshotSignature("/a", 7, settings)).toBe(expected);
  expect(pickerSnapshotSignature("/b", 7, settings)).not.toBe(expected);
  expect(pickerSnapshotSignature("/a", 9, settings)).not.toBe(expected); // A → B → A
  for (const changed of [
    { ...settings, pickerAvailable: ["p/a", "p/b"] }, { ...settings, chosen: ["p/a"] },
    { ...settings, pickerOrder: [] }, { ...settings, pickerOrderMode: "provider" as const },
    { pickerAvailable: settings.pickerAvailable, pickerOrder: settings.pickerOrder, pickerOrderMode: null },
  ]) expect(pickerSnapshotSignature("/a", 7, changed)).not.toBe(expected);
});

test("drop-before re-finds target after removal, while keyboard Down swaps adjacent movable rows", () => {
  const order = ["p/featured", "p/a", "p/b", "p/c"], fixed = ["p/featured"];
  expect(movePickerBefore(order, "p/a", "p/c", fixed)).toEqual(["p/featured", "p/b", "p/a", "p/c"]);
  expect(movePickerBefore(order, "p/c", "p/a", fixed)).toEqual(["p/featured", "p/c", "p/a", "p/b"]);
  expect(movePickerBefore(order, "p/a", "p/b", fixed)).toEqual(order);
  expect(stepPickerOrder(order, "p/a", 1, fixed)).toEqual(["p/featured", "p/b", "p/a", "p/c"]);
  expect(stepPickerOrder(order, "p/c", -1, fixed)).toEqual(["p/featured", "p/a", "p/c", "p/b"]);
  for (const [source, target] of [["outside", "p/a"], ["p/a", "outside"], ["p/a", "p/a"], ["p/featured", "p/b"], ["p/b", "p/featured"]])
    expect(movePickerBefore(order, source!, target!, fixed)).toEqual(order);
  expect(stepPickerOrder(order, "p/a", -1, fixed)).toEqual(order);
  expect(stepPickerOrder(order, "p/c", 1, fixed)).toEqual(order);
  expect(order).toEqual(["p/featured", "p/a", "p/b", "p/c"]);
});


test("blank roster strings retain GET compatibility and preset provenance without becoming featured rows", () => {
  for (const blank of ["", "  "]) {
    const settings = { pickerAvailable: models, chosen: [blank], pickerOrder: ["alpha/alpha", "alpha/zeta", "zeta/beta"],
      pickerOrderMode: "provider" as const };
    expect(isPickerOrderSettings(settings)).toBe(true);
    expect(normalizePickerIds(settings.chosen, models, [])).toEqual([]);
    const identities = [{ provider: "alpha", id: "alpha", namespaced: "alpha/alpha" },
      { provider: "alpha", id: "zeta", namespaced: "alpha/zeta" }, { provider: "zeta", id: "beta", namespaced: "zeta/beta" }];
    expect(customPickerRows(settings, identities)).toEqual({ fixed: [], order: ["alpha/alpha", "alpha/zeta", "zeta/beta"] });
    expect(modelPickerOrderMode(models, settings.pickerOrder, settings.pickerOrderMode)).toBe("provider");
    expect(modelPickerOrder("alphabetical", settings.pickerAvailable)).toEqual(["alpha/alpha", "zeta/beta", "alpha/zeta"]);
    expect(settings.chosen).toEqual([blank]); // Normalization must not rewrite the saved roster.
    expect(isPickerOrderSettings({ ...settings, pickerOrder: [""] })).toBe(false);
    expect(isPickerOrderSettings({ ...settings, pickerAvailable: ["  "] })).toBe(false);
  }
  expect(normalizePickerIds(["", "  ", "alpha/zeta"], models, [])).toEqual(["alpha/zeta"]);
});


test("incomplete or ambiguous catalog identities block projection, even with canonical candidates", () => {
  const settings = { pickerAvailable: ["p/team-model", "p/a"], chosen: ["p/team/model"], pickerOrder: [], pickerOrderMode: null };
  const team = { provider: "p", id: "team/model", namespaced: "p/team-model" };
  const a = { provider: "p", id: "a", namespaced: "p/a" };
  for (const identities of [[], [a], [team], [team, a, { ...team, namespaced: "p/a" }],
    [team, a, { ...team, id: "team-model" }]]) {
    expect(pickerIdentityCoverage(settings.pickerAvailable, identities)).toBe(false);
    expect(customPickerRows(settings, identities)).toBeNull();
  }
  expect(pickerIdentityCoverage(settings.pickerAvailable, [team, a, { ...team }])).toBe(true);
  expect(customPickerRows(settings, [team, a])).toEqual({ fixed: [], order: ["p/team-model", "p/a"] });
});

test("featured picks no longer pin fixed rows regardless of duplicates, aliases, or padding", () => {
  const identities = [{ provider: "p", id: "team/model", namespaced: "p/team-model" },
    { provider: "p", id: "a", namespaced: "p/a" }, { provider: "p", id: "b", namespaced: "p/b" }];
  const settings = { pickerAvailable: ["p/team-model", "p/a", "p/b"], pickerOrder: [], pickerOrderMode: null };
  expect(customPickerRows({ ...settings, chosen: ["p/a", "p/b", "p/a"] }, identities))
    .toEqual({ fixed: [], order: ["p/team-model", "p/a", "p/b"] });
  expect(customPickerRows({ ...settings, chosen: ["p/team/model", "p/b", "p/team-model"] }, identities))
    .toEqual({ fixed: [], order: ["p/team-model", "p/a", "p/b"] });
  expect(customPickerRows({ ...settings, chosen: ["p/team-model", "p/b", "p/team/model"] }, identities))
    .toEqual({ fixed: [], order: ["p/team-model", "p/a", "p/b"] });
  const chosen = [" p/a ", "", "  "];
  expect(customPickerRows({ ...settings, chosen, pickerOrder: [" p/a "] }, identities))
    .toEqual({ fixed: [], order: ["p/a", "p/team-model", "p/b"] });
  expect(chosen).toEqual([" p/a ", "", "  "]);
});
