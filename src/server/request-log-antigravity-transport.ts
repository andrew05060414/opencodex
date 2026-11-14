import type { AdapterRequest } from "../adapters/base";
import { isAntigravityTransportLabel } from "../usage/antigravity-transport";
import type { RequestLogContext } from "./request-log";

/** Stamp the transport the serializing adapter chose onto the attempt this build belongs to. */
export function recordAdapterTransport(logCtx: RequestLogContext, request: AdapterRequest): void {
  const attempt = logCtx.activeAttempt;
  if (attempt && isAntigravityTransportLabel(request.antigravityTransport)) {
    attempt.antigravityTransport = request.antigravityTransport;
  }
}
