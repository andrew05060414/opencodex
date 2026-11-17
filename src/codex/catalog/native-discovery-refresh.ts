import type { OcxConfig } from "../../types";
import type { CodexNativeRosterDiscoveryOutcome } from "../model-entitlements";
import { discoveredNativeModelArrivals } from "./discovered-natives";

export interface NativeDiscoveryRefreshDeps {
  /** Publishes the catalog after discovery; the management route passes its convergence. */
  converge: () => Promise<unknown>;
  /** Defaults to the authenticated roster read the hourly catalog auto-refresh runs. */
  discover?: (config: OcxConfig) => Promise<CodexNativeRosterDiscoveryOutcome>;
}

/**
 * Operator-triggered native GPT discovery. The hourly catalog auto-refresh is otherwise the only
 * caller of the roster read, so a model OpenAI ships between ticks stayed invisible until the next
 * tick. This runs the same read now, then converges so a recorded model reaches the catalog.
 */
export async function refreshNativeModelDiscovery(config: OcxConfig, deps: NativeDiscoveryRefreshDeps) {
  const before = new Set(discoveredNativeModelArrivals().map(row => row.id));
  const discover = deps.discover
    ?? (async (current: OcxConfig) => (await import("../model-entitlements")).discoverCodexNativeRoster(current));
  const outcome = await discover(config).catch(() => "unavailable" as const);
  const catalogRefresh = await deps.converge();
  const disabled = new Set(config.disabledModels ?? []);
  const recentArrivals = discoveredNativeModelArrivals()
    .map(row => ({ ...row, state: disabled.has(row.id) ? "disabled" : "enabled" }));
  return {
    ok: true,
    provider: "native",
    native: true,
    discovery: outcome === "unavailable"
      ? { status: "failed", reason: "roster_unavailable" }
      : { status: "ok", ...(outcome === "not-modified" ? { reason: "not_modified" } : {}) },
    liveModelCount: null,
    newArrivals: recentArrivals.filter(row => !before.has(row.id)),
    recentArrivals,
    catalogRefresh,
  };
}
