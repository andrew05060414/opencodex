import { randomUUID } from "node:crypto";
import type { PrivacyRequestRecord, RedactionHit, RedactionKind, PrivacyStatsRange, PrivacyStatsSummary } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_CLIENT = "unknown";
const UNKNOWN_PROVIDER = "unknown";
const UNKNOWN_MODEL = "unknown";

/**
 * In-memory ring buffer of requests that had at least one redaction. Per
 * privacy_contract.md: memory only, never persisted to disk, capped at the most
 * recent 2000 requests. A record never carries the original secret value or any
 * prefix of it -- only its kind, a count, and the sha256-prefix hash the redactor
 * already computed for the placeholder.
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

  record(entry: Omit<PrivacyRequestRecord, "id">): void {
    if (entry.hits.length === 0) return;
    const record: PrivacyRequestRecord = { ...entry, id: randomUUID() };
    this.buffer[this.head] = record;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
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

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.length = 0;
    this.buffer.length = this.capacity;
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
}): void {
  if (entry.hits.length === 0) return;
  try {
    globalPrivacyStats.record({
      ts: Date.now(),
      client: entry.client,
      provider: entry.provider,
      model: entry.model,
      hits: entry.hits,
      placeholderHashes: entry.placeholderHashes,
    });
  } catch (err) {
    console.warn("[opencodex] privacy stats recording failed (request was not affected):", err);
  }
}

export function sumHits(hits: readonly RedactionHit[]): number {
  return hits.reduce((sum, hit) => sum + hit.count, 0);
}

export function emptyByKind(): Record<RedactionKind, number> {
  return { api_key: 0, password: 0, token: 0, private_key: 0, connection_string: 0, email: 0, other: 0 };
}
