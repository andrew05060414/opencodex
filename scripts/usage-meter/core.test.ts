import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { meterRequest, LedgerMeter } from "./core";
import { allowedRequest, loadMeterPrices } from "./server";
import type { PersistedUsageEntry } from "../../src/usage/log";

const oldHome = process.env.OPENCODEX_HOME;
const root = mkdtempSync(join(tmpdir(), "ocx-meter-"));
const conversation = "meter-fixture-thread";
const digest = createHash("sha256").update(conversation).digest("hex").slice(0, 32);
const fixture = (overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry => ({
  requestId: "meter-request-1", timestamp: Date.now(), provider: "meter-fixture", model: "sample",
  conversationId: digest, status: 200, durationMs: 10_000, firstOutputMs: 7000,
  genStartMs: 2000, lastOutputMs: 8000, usageStatus: "reported", cacheProvenance: "observed",
  usage: { inputTokens: 1000, outputTokens: 600, cacheReadInputTokens: 800, cacheCreationInputTokens: 0, reasoningOutputTokens: 200 },
  ...overrides,
});

beforeAll(() => {
  process.env.OPENCODEX_HOME = root;
  writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { "meter-fixture": {
    apiKey: "do-not-project-credential", modelCosts: { sample: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
  } } }));
  expect(loadMeterPrices(join(root, "config.json"))).toBe("loaded");
});
afterAll(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

test("uses the reasoning-inclusive generation window and keeps end-to-end speed separate", () => {
  const row = meterRequest(fixture());
  expect(row.generation).toMatchObject({ kind: "value", value: 100, estimated: true, timingBasis: "generation-window" });
  expect(row.endToEnd).toMatchObject({ kind: "value", value: 60 });
  expect(row.cacheRate).toBe(0.8);
});

test("unknown and synthesized cache stay unavailable; observed zero remains a real zero", () => {
  expect(meterRequest(fixture({ cacheProvenance: "synthesized" })).cacheRate).toBeNull();
  expect(meterRequest(fixture({ cacheProvenance: "unknown" })).cacheReadTokens).toBeNull();
  expect(meterRequest(fixture({ usage: { inputTokens: 1000, outputTokens: 600, cachedInputTokens: 0 } })).cacheRate).toBe(0);
});

test("a failed or truncated HTTP 200 cannot look like successful measured throughput", () => {
  expect(meterRequest(fixture({ terminalStatus: "incomplete" })).generation.kind).toBe("unavailable");
  expect(meterRequest(fixture({ status: 502 })).endToEnd.kind).toBe("unavailable");
  expect(meterRequest(fixture({ closeReason: "client_cancel" })).generation.kind).toBe("unavailable");
  expect(meterRequest(fixture({ genStartMs: 7900 })).generation.kind).toBe("unavailable");
});

test("uses configured route prices and prices attempts once instead of adding parent usage", () => {
  const single = meterRequest(fixture());
  expect(single.cost.usd).toBeCloseTo(0.00148, 8);
  expect(single.cost.basis).toBe("configured-rate");
  const attempt = { ordinal: 0, provider: "meter-fixture", model: "sample", adapter: "test", status: 200,
    durationMs: 10_000, sendCount: 1, recoveryKinds: [], usageStatus: "reported" as const, usage: fixture().usage };
  const combo = meterRequest(fixture({ attempts: [attempt, { ...attempt, ordinal: 1 }] }));
  expect(combo.cost.usd).toBeCloseTo(0.00296, 8);
  expect(combo.cost.basis).toBe("configured-rate");
  expect(meterRequest(fixture({ attempts: [attempt, { ...attempt, ordinal: 1, model: "unpriced-fixture" }] })).cost.usd).toBeNull();
});

test("only projects allowlisted data, never raw usage or error messages", () => {
  const row = fixture({ upstreamError: "private-request-data", apiKeyId: "private-key-id" });
  const result = JSON.stringify(meterRequest(row));
  expect(result).not.toContain("private-request-data");
  expect(result).not.toContain("private-key-id");
  expect(result).not.toContain("do-not-project-credential");
});

test("reads the whole ledger once, correlates hashed threads, and resumes torn appends without double counting", async () => {
  const ledger = join(root, "usage.jsonl");
  const first = fixture();
  writeFileSync(ledger, JSON.stringify(first) + "\n");
  const meter = new LedgerMeter(`codex://threads/${conversation}?view=chat`);
  await meter.refresh();
  expect(meter.snapshot().session?.requests).toBe(1);
  expect(meter.snapshot().invalidRows).toBe(0);
  expect(meter.snapshot().latest?.id).toBe(first.requestId);
  const second = JSON.stringify(fixture({ requestId: "meter-request-2" }));
  appendFileSync(ledger, second.slice(0, 50));
  await meter.refresh();
  expect(meter.snapshot().session?.requests).toBe(1);
  appendFileSync(ledger, second.slice(50) + "\n");
  await meter.refresh();
  expect(meter.snapshot().session?.requests).toBe(2);
  await meter.refresh();
  expect(meter.snapshot().today.requests).toBe(2);
  expect(meter.snapshot().invalidRows).toBe(0);
  expect(meter.snapshot().session?.totalTokens).toBe(3200);
  expect(meter.snapshot().session?.estimatedCostUsd).toBeCloseTo(0.00296, 8);
  // A replaced/truncated ledger rebuilds instead of retaining stale totals.
  writeFileSync(ledger, JSON.stringify(fixture({ requestId: "replacement" })) + "\n");
  await meter.refresh();
  expect(meter.snapshot().session?.requests).toBe(1);
  expect(meter.snapshot().latest?.id).toBe("replacement");
  // Malformed complete lines stay visible in coverage after later valid appends.
  appendFileSync(ledger, "not-json\n");
  await meter.refresh();
  expect(meter.snapshot().invalidRows).toBe(1);
  appendFileSync(ledger, JSON.stringify(fixture({ requestId: "after-invalid" })) + "\n");
  await meter.refresh();
  expect(meter.snapshot().invalidRows).toBe(1);
  expect(meter.snapshot().session?.requests).toBe(2);
});

test("rejects cross-origin requests and DNS rebinding", () => {
  expect(allowedRequest(new Request("http://127.0.0.1:18082/api/snapshot"), 18082)).toBe(true);
  expect(allowedRequest(new Request("http://evil.invalid:18082/api/snapshot"), 18082)).toBe(false);
  expect(allowedRequest(new Request("http://127.0.0.1:18082/api/snapshot", { headers: { origin: "https://evil.invalid" } }), 18082)).toBe(false);
});
