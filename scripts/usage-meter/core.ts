/** Read-only projection of OpenCodex's ledger using its own accounting contracts. */
import { cacheObservationFromUsage, createUsageSummaryAccumulator, type UsageSummary, type UsageSummaryAccumulator } from "../../src/usage/summary";
import { costResult, decodeTokPerSecondResult, tokPerSecondResult } from "../../src/server/management/shared";
import { matchesLogConversationId, unwrapLogConversationQuery } from "../../src/server/request-log-conversation";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError, type UsageLedgerScanResult } from "../../src/usage/ledger-scanner";
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey, type PersistedUsageEntry } from "../../src/usage/log";
import { classifyRequestOutcome } from "../../src/usage/request-outcome";
import { runPassiveRead } from "../../src/lib/passive-read";
import { closeSync, openSync, readSync } from "node:fs";
import { USAGE_LEDGER_MAX_LINE_BYTES } from "../../src/usage/ledger-scanner";

function tornSuffixInvalid(scan: UsageLedgerScanResult): number {
  const remaining = (scan.revision?.size ?? 0) - scan.processedThroughBytes;
  if (!scan.invalidRows || !scan.revision || remaining <= 0 || remaining > USAGE_LEDGER_MAX_LINE_BYTES) return 0;
  const fd = openSync(scan.revision.path, "r");
  try {
    const bytes = Buffer.alloc(remaining);
    const count = readSync(fd, bytes, 0, remaining, scan.processedThroughBytes);
    return bytes.subarray(0, count).some(byte => ![9, 10, 13, 32].includes(byte)) ? 1 : 0;
  } finally { closeSync(fd); }
}

export function meterRequest(entry: PersistedUsageEntry) {
  const cache = cacheObservationFromUsage(entry.usage, entry.cacheProvenance);
  const cost = costResult(entry);
  const outcome = classifyRequestOutcome(entry);
  const completed = outcome === "completed";
  const unavailable = { kind: "unavailable" as const, reason: "request_not_completed" };
  return {
    id: entry.requestId,
    timestamp: entry.timestamp,
    conversation: entry.conversationId ?? null,
    provider: entry.provider,
    model: entry.model,
    servedModel: entry.servedModel ?? entry.resolvedModel ?? entry.model,
    status: entry.status,
    outcome,
    completed,
    durationMs: entry.durationMs,
    firstOutputMs: entry.firstOutputMs ?? null,
    generation: completed ? decodeTokPerSecondResult(entry) : unavailable,
    endToEnd: completed ? tokPerSecondResult(entry) : unavailable,
    usageStatus: entry.usageStatus,
    inputTokens: entry.usage?.inputTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    reasoningTokens: entry.usage?.reasoningOutputTokens ?? null,
    cacheProvenance: cache.provenance,
    cacheReadTokens: cache.provenance === "observed" ? cache.read ?? null : null,
    cacheRate: cache.provenance === "observed" && (entry.usage?.inputTokens ?? 0) > 0
      ? Math.min(1, (cache.read ?? 0) / entry.usage!.inputTokens) : null,
    cost: cost.kind === "value" ? {
      usd: cost.estimate.cost.total,
      reasons: cost.estimateReasons,
      lowerBound: cost.estimate.priorityLowerBound === true,
      basis: cost.estimateReasons.includes("provider_cost_overlay") ? "configured-rate" : "api-list-estimate",
      attempts: cost.estimate.attempts?.length ?? 1,
    } : { usd: null, reason: cost.reason, basis: "unavailable" },
  };
}

export type MeterRequest = ReturnType<typeof meterRequest>;

/** Accounts, API key ids, raw usage objects and diagnostics never leave this process. */
export function meterSummary(data: UsageSummary) {
  const totals = data.summary;
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    estimatedCostUsd: totals.pricedRequests > 0 ? totals.estimatedCostUsd : null,
    pricedRequests: totals.pricedRequests,
    unpricedRequests: totals.unpricedRequests,
    unmeteredRequests: totals.unmeteredRequests,
    coverageRatio: totals.coverageRatio,
    providers: data.providers.map(row => ({
      provider: row.provider, requests: row.requests,
      totalTokens: row.totalTokens, estimatedCostUsd: row.estimatedCostUsd ?? null,
      pricedRequests: row.pricedRequests, unpricedRequests: row.unpricedRequests,
    })),
    models: data.models.map(row => ({
      provider: row.provider, model: row.model, requests: row.requests,
      totalTokens: row.totalTokens, estimatedCostUsd: row.estimatedCostUsd ?? null,
      pricedRequests: row.pricedRequests, unpricedRequests: row.unpricedRequests,
      cacheRate: row.cacheHitRate ?? null,
      cacheObservedInputTokens: row.cacheObservedInputTokens,
    })),
  };
}

/** One cooperative initial scan; subsequent refreshes read only appended LF-complete rows. */
export class LedgerMeter {
  private all = createUsageSummaryAccumulator();
  private session = createUsageSummaryAccumulator();
  private recent: MeterRequest[] = [];
  private recentSession: MeterRequest[] = [];
  private cursor: UsageLedgerScanResult | null = null;
  private flight: Promise<void> | null = null;
  private invalidRows = 0;
  private oversizedRows = 0;
  private parsedRows = 0;
  private updatedAt: number | null = null;
  private conversation: string;

  constructor(conversation = "") {
    this.conversation = unwrapLogConversationQuery(conversation.trim());
  }

  private reset() {
    this.all = createUsageSummaryAccumulator();
    this.session = createUsageSummaryAccumulator();
    this.recent = [];
    this.recentSession = [];
    this.cursor = null;
    this.invalidRows = 0;
    this.oversizedRows = 0;
    this.parsedRows = 0;
  }

  async refresh() {
    if (this.flight) return this.flight;
    this.flight = runPassiveRead(() => this.scan());
    try { await this.flight; } finally { this.flight = null; }
  }

  private async scan() {
    if (this.cursor && usageLogRevisionKey(currentUsageLogRevision()) === usageLogRevisionKey(this.cursor.revision)) {
      this.updatedAt = Date.now();
      return;
    }
    for (let retry = 0; retry < 2; retry++) {
      // Publish only a complete scan. A failed or rotated read cannot double-count on retry.
      const all = this.all.clone();
      const session = this.session.clone();
      const recent = [...this.recent];
      const recentSession = [...this.recentSession];
      try {
        const result = await scanUsageLedgerCooperatively({
          ...(this.cursor?.processedThroughBytes ? {
            startAtBytes: this.cursor.processedThroughBytes,
            expectedIdentityKey: usageLogIdentityKey(this.cursor.revision),
            expectedProcessedThroughDigest: this.cursor.processedThroughDigest,
          } : {}),
          onEntry: entry => {
            all.add(entry);
            const matches = this.conversation && matchesLogConversationId(entry.conversationId, this.conversation);
            if (matches) session.add(entry);
            const projection = meterRequest(entry);
            const duplicate = recent.findIndex(row => row.id === projection.id);
            if (duplicate !== -1) recent.splice(duplicate, 1);
            recent.push(projection);
            if (recent.length > 200) recent.shift();
            if (matches) {
              const index = recentSession.findIndex(row => row.id === projection.id);
              if (index !== -1) recentSession.splice(index, 1);
              recentSession.push(projection);
              if (recentSession.length > 30) recentSession.shift();
            }
          },
        });
        const committedInvalid = Math.max(0, result.invalidRows - tornSuffixInvalid(result));
        this.all = all;
        this.session = session;
        this.recent = recent;
        this.recentSession = recentSession;
        this.cursor = result;
        this.parsedRows += result.parsedRows;
        // A torn suffix is retried at the same boundary; count only committed malformed lines.
        this.invalidRows += committedInvalid;
        this.oversizedRows += result.oversizedRows;
        this.updatedAt = Date.now();
        return;
      } catch (error) {
        if (error instanceof UsageLedgerRebuildRequiredError && retry === 0) {
          this.reset();
          continue;
        }
        throw error;
      }
    }
  }

  snapshot(now = Date.now()) {
    const scoped = this.conversation ? this.recentSession : this.recent;
    return {
      schemaVersion: 1,
      source: "opencodex-local-ledger",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      generatedAt: now,
      updatedAt: this.updatedAt,
      conversation: this.conversation || null,
      sourceExists: this.cursor?.revision !== null && this.cursor !== null,
      parsedRows: this.parsedRows,
      invalidRows: this.invalidRows,
      oversizedRows: this.oversizedRows,
      completedRequestsOnly: true,
      today: meterSummary(this.all.summarize("today", now)),
      session: this.conversation ? meterSummary(this.session.summarize("all", now)) : null,
      latest: scoped.at(-1) ?? null,
      recent: scoped.slice(-30).reverse(),
      recentAll: this.recent.slice(-30).reverse(),
      latestGlobal: this.recent.at(-1) ?? null,
    };
  }
}
