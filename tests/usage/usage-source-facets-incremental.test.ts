import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUsageSourceFacets, resetUsageSourceFacetsForTests } from "../../src/server/management/usage-source-facets";
import * as usageLedgerScannerModule from "../../src/usage/ledger-scanner";
import type { UsageSourceFilter } from "../../src/usage/source-filter";

const ALL: UsageSourceFilter = { client: "all", device: { kind: "all" } };
let testDir = "";
let previousHome: string | undefined;

function line(requestId: string, timestamp: number): string {
  return JSON.stringify({
    requestId, timestamp, provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1,
    usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2,
  });
}

/** Facets without the window stamp, which reflects the moment of each call rather than the ledger. */
async function facetsWithoutWindow() {
  const { window: _window, ...rest } = await getUsageSourceFacets(ALL, []);
  return rest;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-facets-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageSourceFacetsForTests();
});

afterEach(() => {
  resetUsageSourceFacetsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage source facets are folded incrementally", () => {
  test("a repeat call after the ledger grew scans only the appended bytes and matches a full rescan", async () => {
    const now = Date.now();
    const ledger = join(testDir, "usage.jsonl");
    writeFileSync(ledger, `${line("a", now - 3_000)}\n${line("b", now - 2_000)}\n${line("c", now - 1_000)}\n`);
    expect((await getUsageSourceFacets(ALL, [])).devices[0]?.requests).toBe(3);

    // One in-window row, one stamped in the future and one older than the 30-day window.
    appendFileSync(ledger, `${line("d", now)}\n${line("future", now + 60_000)}\n${line("old", now - 40 * 86_400_000)}\n`);
    const scan = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively");
    const incremental = await facetsWithoutWindow();
    const startedAt = scan.mock.calls.map(call => call[0].startAtBytes ?? 0);
    scan.mockRestore();

    expect(startedAt.length).toBe(1);
    expect(startedAt[0]).toBeGreaterThan(0);
    expect(incremental.devices[0]?.requests).toBe(4);

    resetUsageSourceFacetsForTests();
    expect(incremental).toEqual(await facetsWithoutWindow());
  });

  test("a row stamped after one call's upper bound is counted by the first call whose window reaches it", async () => {
    const now = Date.now();
    const ledger = join(testDir, "usage.jsonl");
    writeFileSync(ledger, `${line("a", now - 1_000)}\n`);
    expect((await getUsageSourceFacets(ALL, [])).devices[0]?.requests).toBe(1);

    appendFileSync(ledger, `${line("ahead", Date.now() + 1_200)}\n`);
    expect((await getUsageSourceFacets(ALL, [])).devices[0]?.requests).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 1_300));
    const reached = await facetsWithoutWindow();
    expect(reached.devices[0]?.requests).toBe(2);

    resetUsageSourceFacetsForTests();
    expect(reached).toEqual(await facetsWithoutWindow());
  });

  test("a ledger replaced by a shorter file is rescanned in full and matches a fresh read", async () => {
    const now = Date.now();
    const ledger = join(testDir, "usage.jsonl");
    writeFileSync(ledger, `${line("a", now - 3_000)}\n${line("b", now - 2_000)}\n`);
    expect((await getUsageSourceFacets(ALL, [])).devices[0]?.requests).toBe(2);

    writeFileSync(ledger, `${line("z", now - 500)}\n`);
    const replaced = await facetsWithoutWindow();
    expect(replaced.devices[0]?.requests).toBe(1);

    resetUsageSourceFacetsForTests();
    expect(replaced).toEqual(await facetsWithoutWindow());
  });
});
