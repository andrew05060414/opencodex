import { randomUUID } from "node:crypto";
import { secretValueId } from "./redact";
import type { PrivacyRequestRecord, RedactionHit, RedactionKind, RedactionSample, PrivacyStatsRange, PrivacyStatsSummary } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_CLIENT = "unknown";
const UNKNOWN_PROVIDER = "unknown";
const UNKNOWN_MODEL = "unknown";
/** `summary()` lists at most 200 requests, so more ids than that could never be matched. */
const MAX_REQUEST_IDS_PER_VALUE = 200;

/** One distinct redacted original, as served by reveal mode. Holds a real secret. */
export interface PrivacyRevealedValue extends RedactionSample {
  /** The value's hash-prefix id: the same id an `allowValues` entry for it is listed and deleted by. */
  id: string;
  /** How many retained requests carried this value. */
  requests: number;
  /** Ids of those requests (as in `summary().requests[].id`), newest first, capped. */
  requestIds: string[];
  lastSeen: string;
  client: string;
  provider: string;
  model: string;
}

/**
 * In-memory ring buffer of requests that had at least one redaction. Per
 * privacy_contract.md: memory only, never persisted to disk, capped at the most
 * recent 2000 requests. A record never carries the original secret value or any
 * prefix of it -- only its kind, a count, and the sha256-prefix hash the redactor
 * already computed for the placeholder. The one exception is the opt-in reveal mode
 * (`privacy.revealValues`): then a record also keeps `samples` (the originals), still
 * memory only, and only `revealedValues()` ever reads them.
 */
export class PrivacyStatsStore {
  private readonly capacity: number;
  private readonly buffer: PrivacyRequestRecord[];
  private head = 0;
  private count = 0;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 2000;
    this.buffer = new Array(this.capacity);
  }

  /** Returns the generated record id (for a later `backfillRoute`), or null if nothing was recorded. */
  record(entry: Omit<PrivacyRequestRecord, "id">): string | null {
    if (entry.hits.length === 0) return null;
    const id = randomUUID();
    const record: PrivacyRequestRecord = { ...entry, id };
    this.buffer[this.head] = record;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    return id;
  }

  /**
   * Fills in `provider`/`model` once routing has settled, for a record created before that was
   * known (redaction is mounted ahead of routing, so the request is visible in stats -- as
   * `provider: "unknown"` -- even if it never reaches a route). A missing id or an id for a
   * record already evicted by the ring buffer's capacity is a silent no-op: never affects the
   * request, and stale/duplicate backfills simply do nothing.
   */
  backfillRoute(id: string | null | undefined, patch: { provider?: string; model?: string }): void {
    if (!id) return;
    for (let i = 0; i < this.count; i += 1) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item && item.id === id) {
        if (patch.provider !== undefined) item.provider = patch.provider;
        if (patch.model !== undefined) item.model = patch.model;
        return;
      }
    }
  }

  private all(): PrivacyRequestRecord[] {
    const out: PrivacyRequestRecord[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item) out.push(item);
    }
    return out; // newest first
  }

  /** Forget every retained original (reveal mode turned off) without touching counts or hashes. */
  dropSamples(): void {
    for (let i = 0; i < this.count; i += 1) {
      const item = this.buffer[i];
      if (item) delete item.samples;
    }
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.length = 0;
    this.buffer.length = this.capacity;
  }

  /**
   * Reveal mode: the distinct originals redacted in the window, newest first, with how many
   * retained requests carried each. Serves `GET /api/privacy/values`; only the records that
   * were captured with `privacy.revealValues` on contribute.
   */
  revealedValues(range: PrivacyStatsRange, limit: number, now: number = Date.now()): PrivacyRevealedValue[] {
    const since = now - (range === "30d" ? 30 : 7) * DAY_MS;
    const byValue = new Map<string, PrivacyRevealedValue>();
    for (const record of this.all()) { // newest first
      if (record.ts < since || !record.samples) continue;
      for (const sample of record.samples) {
        const key = `${sample.kind}\u0000${sample.value}`;
        const seen = byValue.get(key);
        if (seen) {
          seen.requests += 1;
          if (seen.requestIds.length < MAX_REQUEST_IDS_PER_VALUE) seen.requestIds.push(record.id);
          continue;
        }
        byValue.set(key, {
          id: secretValueId(sample.value),
          kind: sample.kind,
          value: sample.value,
          context: sample.context,
          source: sample.source,
          requests: 1,
          requestIds: [record.id],
          lastSeen: new Date(record.ts).toISOString(),
          client: record.client ?? UNKNOWN_CLIENT,
          provider: record.provider ?? UNKNOWN_PROVIDER,
          model: record.model ?? UNKNOWN_MODEL,
        });
      }
    }
    return [...byValue.values()].slice(0, Math.max(0, limit));
  }

  summary(range: PrivacyStatsRange, enabled: boolean, now: number = Date.now()): PrivacyStatsSummary {
    const days = range === "30d" ? 30 : 7;
    const since = now - days * DAY_MS;
    const records = this.all().filter((r) => r.ts >= since);

    let masked = 0;
    const distinctHashes = new Set<string>();
    const byDay = new Map<string, number>();
    const byFlow = new Map<string, { client: string; provider: string; masked: number }>();

    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
      byDay.set(date, 0);
    }

    for (const record of records) {
      const total = record.hits.reduce((sum, hit) => sum + hit.count, 0);
      masked += total;
      for (const hash of record.placeholderHashes) distinctHashes.add(hash);
      const date = new Date(record.ts).toISOString().slice(0, 10);
      if (byDay.has(date)) byDay.set(date, (byDay.get(date) ?? 0) + total);
      const client = record.client ?? UNKNOWN_CLIENT;
      const provider = record.provider ?? UNKNOWN_PROVIDER;
      const flowKey = `${client}\u0000${provider}`;
      const flow = byFlow.get(flowKey) ?? { client, provider, masked: 0 };
      flow.masked += total;
      byFlow.set(flowKey, flow);
    }

    return {
      enabled,
      range,
      totals: { masked, distinctValues: distinctHashes.size, requests: records.length },
      daily: [...byDay.entries()].map(([date, maskedCount]) => ({ date, masked: maskedCount })),
      flows: [...byFlow.values()].sort((a, b) => b.masked - a.masked),
      requests: records.slice(0, 200).map((record) => ({
        id: record.id,
        ts: new Date(record.ts).toISOString(),
        client: record.client ?? UNKNOWN_CLIENT,
        provider: record.provider ?? UNKNOWN_PROVIDER,
        model: record.model ?? UNKNOWN_MODEL,
        hits: record.hits,
        total: record.hits.reduce((sum, hit) => sum + hit.count, 0),
      })),
    };
  }
}

export const globalPrivacyStats = new PrivacyStatsStore();

/**
 * Best-effort stats write: a failure here must never affect the request (privacy_contract.md
 * fail-closed rule applies only to the REDACTION step, not to recording it). Swallows and logs.
 */
export function recordPrivacyHitsBestEffort(entry: {
  client?: string;
  provider?: string;
  model?: string;
  hits: RedactionHit[];
  placeholderHashes: string[];
  /** Reveal mode only (`privacy.revealValues`). */
  samples?: RedactionSample[];
}): string | null {
  if (entry.hits.length === 0) return null;
  try {
    return globalPrivacyStats.record({
      ts: Date.now(),
      client: entry.client,
      provider: entry.provider,
      model: entry.model,
      hits: entry.hits,
      placeholderHashes: entry.placeholderHashes,
      ...(entry.samples && entry.samples.length > 0 ? { samples: entry.samples } : {}),
    });
  } catch (err) {
    console.warn("[opencodex] privacy stats recording failed (request was not affected):", err);
    return null;
  }
}

/**
 * Best-effort backfill once routing has settled; see `PrivacyStatsStore.backfillRoute`. Never
 * throws, and a missing/stale/absent id is a silent no-op -- the request is never affected.
 */
export function backfillPrivacyRouteBestEffort(id: string | null | undefined, patch: { provider?: string; model?: string }): void {
  if (!id) return;
  try {
    globalPrivacyStats.backfillRoute(id, patch);
  } catch (err) {
    console.warn("[opencodex] privacy stats route backfill failed (request was not affected):", err);
  }
}

export function sumHits(hits: readonly RedactionHit[]): number {
  return hits.reduce((sum, hit) => sum + hit.count, 0);
}

export function emptyByKind(): Record<RedactionKind, number> {
  return { api_key: 0, password: 0, token: 0, private_key: 0, connection_string: 0, email: 0, other: 0 };
}
