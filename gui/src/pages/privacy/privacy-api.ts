/**
 * Data access for the Privacy page: the three contract routes, plus the normalisation that
 * keeps an unexpected payload from reaching the renderer.
 *
 * Mock data is reachable only through `?mock=1` on a dev server. The gate is checked before
 * the mock module is even imported — the import is dynamic, so a production bundle puts the
 * fixtures in a chunk nothing ever requests, and `import.meta.env.DEV` keeps the branch from
 * being taken at all. That is the whole reason this file owns the switch rather than the page.
 */
import { readJsonOrThrow } from "../../fetch-json";
import {
  asPrivacyKind,
  type PrivacyConfig,
  type PrivacyHit,
  type PrivacyRange,
  type PrivacyStats,
  type PrivacyTestResult,
} from "./privacy-types";

/**
 * Folded to `false` by the bundler in a production build, which is what lets the dynamic
 * `import("./privacy-mock")` below be eliminated rather than merely never called.
 */
const DEV_BUILD = import.meta.env.DEV === true;

/** True only on a dev server that was opened with `?mock=1`. */
export function privacyMockEnabled(search?: string, dev: boolean = DEV_BUILD): boolean {
  if (!dev) return false;
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(query).get("mock") === "1";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeHits(value: unknown): PrivacyHit[] {
  if (!Array.isArray(value)) return [];
  return value.map(hit => {
    const row = (hit ?? {}) as { kind?: unknown; count?: unknown };
    return { kind: asPrivacyKind(row.kind), count: num(row.count) };
  });
}

export function normalizePrivacyStats(value: unknown, fallbackRange: PrivacyRange): PrivacyStats {
  // Read the payload as loose records: it arrives from the network, so every field is a
  // claim until this function has checked it.
  const raw = (value ?? {}) as {
    enabled?: unknown;
    range?: unknown;
    totals?: Record<string, unknown>;
    daily?: { date?: unknown; masked?: unknown }[];
    flows?: { client?: unknown; provider?: unknown; masked?: unknown }[];
    requests?: Record<string, unknown>[];
  };
  const totals = (raw.totals ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    range: raw.range === "30d" || raw.range === "7d" ? raw.range : fallbackRange,
    totals: {
      masked: num(totals.masked),
      distinctValues: num(totals.distinctValues),
      requests: num(totals.requests),
    },
    daily: Array.isArray(raw.daily)
      ? raw.daily.map(day => ({ date: str((day ?? {}).date), masked: num((day ?? {}).masked) }))
      : [],
    flows: Array.isArray(raw.flows)
      ? raw.flows.map(flow => ({
        client: str((flow ?? {}).client),
        provider: str((flow ?? {}).provider),
        masked: num((flow ?? {}).masked),
      }))
      : [],
    requests: Array.isArray(raw.requests)
      ? raw.requests.map(request => {
        const row = request ?? {};
        const hits = normalizeHits(row.hits);
        return {
          id: str(row.id),
          ts: str(row.ts),
          client: str(row.client),
          provider: str(row.provider),
          model: str(row.model),
          hits,
          total: num(row.total) || hits.reduce((sum, hit) => sum + hit.count, 0),
        };
      })
      : [],
  };
}

export function normalizePrivacyConfig(value: unknown): PrivacyConfig {
  const raw = (value ?? {}) as Partial<PrivacyConfig>;
  return {
    enabled: raw.enabled === true,
    allowValues: Array.isArray(raw.allowValues) ? raw.allowValues.filter(v => typeof v === "string") : [],
  };
}

export function normalizePrivacyTestResult(value: unknown): PrivacyTestResult {
  const raw = (value ?? {}) as Partial<PrivacyTestResult>;
  return { masked: str(raw.masked), hits: normalizeHits(raw.hits) };
}

async function mock() {
  return await import("./privacy-mock");
}

export async function fetchPrivacyStats(
  apiBase: string,
  range: PrivacyRange,
  signal: AbortSignal,
  failMessage: string,
): Promise<PrivacyStats> {
  if (DEV_BUILD && privacyMockEnabled()) return (await mock()).mockPrivacyStats(range);
  const res = await fetch(`${apiBase}/api/privacy/stats?range=${range}`, { signal, cache: "no-store" });
  return normalizePrivacyStats(await readJsonOrThrow<unknown>(res, failMessage), range);
}

export async function fetchPrivacyConfig(
  apiBase: string,
  signal: AbortSignal,
  failMessage: string,
): Promise<PrivacyConfig> {
  if (DEV_BUILD && privacyMockEnabled()) return (await mock()).mockPrivacyConfig();
  const res = await fetch(`${apiBase}/api/privacy/config`, { signal, cache: "no-store" });
  return normalizePrivacyConfig(await readJsonOrThrow<unknown>(res, failMessage));
}

export async function savePrivacyConfig(
  apiBase: string,
  next: PrivacyConfig,
  failMessage: string,
  signal?: AbortSignal,
): Promise<PrivacyConfig> {
  if (DEV_BUILD && privacyMockEnabled()) return (await mock()).mockSavePrivacyConfig(next);
  const res = await fetch(`${apiBase}/api/privacy/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
    signal,
  });
  const body = await readJsonOrThrow<unknown>(res, failMessage);
  // A 204 is a legitimate answer to a write; the request body is then the new truth.
  return body === undefined ? next : normalizePrivacyConfig(body);
}

export async function runPrivacyTest(
  apiBase: string,
  text: string,
  failMessage: string,
  signal?: AbortSignal,
): Promise<PrivacyTestResult> {
  if (DEV_BUILD && privacyMockEnabled()) return (await mock()).mockPrivacyTest(text);
  const res = await fetch(`${apiBase}/api/privacy/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  return normalizePrivacyTestResult(await readJsonOrThrow<unknown>(res, failMessage));
}
