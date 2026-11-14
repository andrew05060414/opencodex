import type { OcxProviderConfig } from "../../types";

export const AGY_TRANSPORT_REQUEST_HEADER = "x-opencodex-antigravity-transport";
export type AntigravityTransport = "agy" | "direct";

/** The inbound header wins in both directions; otherwise the provider flag decides. */
export function chooseAntigravityTransport(
  provider: Pick<OcxProviderConfig, "agyTransport">,
  headers?: Headers,
): AntigravityTransport {
  const requested = headers?.get(AGY_TRANSPORT_REQUEST_HEADER)?.trim().toLowerCase();
  if (requested === "agy" || requested === "direct") return requested;
  return provider.agyTransport?.enabled === true ? "agy" : "direct";
}
