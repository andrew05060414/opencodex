import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError, type UsageLedgerScanResult } from "../../usage/ledger-scanner";
import { usageLogIdentityKey, type PersistedUsageEntry } from "../../usage/log";
import { createSourceFacetAccumulator } from "../../usage/source-facets";
import { snapshotConfiguredKeyIds, type UsageSourceFilter } from "../../usage/source-filter";
import { rangeWindow } from "../../usage/summary";

const MAX_FLIGHTS = 4;
/** One entry per (filter, configured keys, time zone, window start); a dashboard uses a handful. */
const MAX_RETAINED_STATES = 4;
/**
 * Rows stamped after the moment of the scan that read them. Normally there are none, so the cap
 * only bounds a pathological clock. Past it the state is answered once and not retained.
 */
const MAX_PENDING_ROWS = 4096;

export class SourceFacetsBusyError extends Error {}
type SourceFacets = ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
};

interface RetainedFacetState {
  /** Counts rows with `since <= timestamp <= lastUntil`; the window's upper bound is applied by the caller. */
  accumulator: ReturnType<typeof createSourceFacetAccumulator>;
  /** Rows read by an earlier scan whose timestamp was after that scan's `until`. */
  pending: PersistedUsageEntry[];
  lastUntil: number;
  identityKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
  usageIncomplete: boolean;
}

interface FacetBase {
  captured: UsageSourceFilter;
  ids: readonly string[];
  since: number;
}

const flights = new Map<string, Promise<SourceFacets>>();
const retained = new Map<string, RetainedFacetState>();

function emptyState(base: FacetBase): RetainedFacetState {
  return {
    // The upper bound is enforced by `scanInto`, so that a state can outlive the scan that built it.
    accumulator: createSourceFacetAccumulator(base.captured, base.ids, { since: base.since, until: Number.MAX_SAFE_INTEGER }),
    pending: [],
    lastUntil: Number.NEGATIVE_INFINITY,
    identityKey: usageLogIdentityKey(null),
    processedThroughBytes: 0,
    processedThroughDigest: "",
    usageIncomplete: false,
  };
}

/**
 * Read the ledger from `startAtBytes` and fold the rows into `state`. The caller owns `state`
 * until this resolves, and discards it when this rejects, because a failed scan may already have
 * folded part of the suffix into the counts.
 */
async function scanInto(state: RetainedFacetState, base: FacetBase, until: number, startAtBytes: number): Promise<{ retain: boolean }> {
  let overflowed = false;
  const scan: UsageLedgerScanResult = await scanUsageLedgerCooperatively({
    startAtBytes,
    ...(startAtBytes > 0 ? { expectedIdentityKey: state.identityKey, expectedProcessedThroughDigest: state.processedThroughDigest } : {}),
    onEntry(row) {
      if (!Number.isFinite(row.timestamp) || row.timestamp < base.since) return;
      if (row.timestamp > until) {
        if (state.pending.length < MAX_PENDING_ROWS) state.pending.push(row);
        else overflowed = true;
        return;
      }
      state.accumulator.add(row);
    },
  });
  // Rows held back by an earlier scan join the counts once the window's upper bound reaches them.
  state.pending = state.pending.filter(row => {
    if (row.timestamp > until) return true;
    state.accumulator.add(row);
    return false;
  });
  state.identityKey = usageLogIdentityKey(scan.revision);
  state.processedThroughBytes = scan.processedThroughBytes;
  state.processedThroughDigest = scan.processedThroughDigest;
  state.lastUntil = until;
  state.usageIncomplete = state.usageIncomplete || scan.oversizedRows > 0 || scan.invalidRows > 0;
  return { retain: !overflowed };
}

/** Scan only the bytes the ledger gained since the last scan; a full scan when that is not provably a suffix. */
async function advance(stateKey: string, base: FacetBase, until: number): Promise<{ state: RetainedFacetState; retain: boolean }> {
  const existing = retained.get(stateKey);
  retained.delete(stateKey);
  // A clock that moved backwards would leave rows counted that the window no longer admits.
  if (existing && until >= existing.lastUntil) {
    try {
      const { retain } = await scanInto(existing, base, until, existing.processedThroughBytes);
      return { state: existing, retain };
    } catch (error) {
      if (!(error instanceof UsageLedgerRebuildRequiredError)) throw error;
    }
  }
  const state = emptyState(base);
  const { retain } = await scanInto(state, base, until, 0);
  return { state, retain };
}

function retain(stateKey: string, state: RetainedFacetState): void {
  retained.delete(stateKey);
  retained.set(stateKey, state);
  while (retained.size > MAX_RETAINED_STATES) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
}

/** Single-flight identical requests; never retain arbitrary historical key IDs. */
export async function getUsageSourceFacets(filter: UsageSourceFilter, configuredIds: readonly string[]): Promise<SourceFacets> {
  const ids = snapshotConfiguredKeyIds(configuredIds);
  const captured: UsageSourceFilter = { client: filter.client, device: { ...filter.device } };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const until = Date.now();
  const since = rangeWindow("30d", until).since!;
  const stateKey = JSON.stringify([captured, ids, timeZone, since]);
  const existing = flights.get(stateKey);
  if (existing) return existing;
  if (flights.size >= MAX_FLIGHTS) throw new SourceFacetsBusyError("usage facets busy");
  const base: FacetBase = { captured, ids, since };
  const flight = (async () => {
    const { state, retain: keep } = await advance(stateKey, base, until);
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
    if (keep) retain(stateKey, state);
    return { ...state.accumulator.snapshot(), sourceFilter: captured, window: { since, until, timeZone },
      usageIncomplete: state.usageIncomplete };
  })();
  flights.set(stateKey, flight);
  try { return await flight; } finally { if (flights.get(stateKey) === flight) flights.delete(stateKey); }
}

/** Test seam: forget retained facet states so the next call starts from a full scan. */
export function resetUsageSourceFacetsForTests(): void {
  retained.clear();
}
