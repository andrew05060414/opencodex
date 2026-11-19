import type { OcxProviderConfig } from "../types";

/**
 * One request may move to at most this many sibling accounts on google-antigravity, whatever the
 * error (401, 403, 404, 429, 5xx). A request must never walk the whole pool: a decoy refusal then
 * exposes every spare account at once.
 */
export const ANTIGRAVITY_DEFAULT_MAX_FAILOVER_HOPS_PER_REQUEST = 2;
export const ANTIGRAVITY_MAX_FAILOVER_HOPS_CEILING = 6;

/** `providers.google-antigravity.oauthAccountFailover.maxFailoverHopsPerRequest`, integer 0..6, default 2. */
export function antigravityMaxFailoverHops(provider: Pick<OcxProviderConfig, "oauthAccountFailover"> | undefined): number {
  const value = provider?.oauthAccountFailover?.maxFailoverHopsPerRequest;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= ANTIGRAVITY_MAX_FAILOVER_HOPS_CEILING
    ? value : ANTIGRAVITY_DEFAULT_MAX_FAILOVER_HOPS_PER_REQUEST;
}
