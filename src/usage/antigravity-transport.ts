import type { PersistedUsageAttempt } from "./log";

/**
 * How one google-antigravity send left this proxy: through the agy ACP bridge or the direct
 * Google transport. A closed two-value roster, so it carries no account, token, URL or body.
 */
export type AntigravityTransportLabel = "agy" | "direct";

export function isAntigravityTransportLabel(value: unknown): value is AntigravityTransportLabel {
  return value === "agy" || value === "direct";
}

/** Persist the label only when it is a roster member; every other provider's rows keep their shape. */
export function antigravityTransportField(value: unknown): { antigravityTransport?: AntigravityTransportLabel } {
  return isAntigravityTransportLabel(value) ? { antigravityTransport: value } : {};
}

/** The request-level label is the one the last attempt that carries a label used. */
export function lastAttemptAntigravityTransport(
  attempts: readonly Pick<PersistedUsageAttempt, "antigravityTransport">[] | undefined,
): AntigravityTransportLabel | undefined {
  for (let index = (attempts?.length ?? 0) - 1; index >= 0; index--) {
    const label = attempts?.[index]?.antigravityTransport;
    if (isAntigravityTransportLabel(label)) return label;
  }
  return undefined;
}
