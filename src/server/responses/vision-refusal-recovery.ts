import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { isImageCapabilityRefusal, rememberVisionRefusal } from "../../vision/refusals";
import { prepareResponsesSidecarAuth } from "./request-sidecar-auth";

type Context = Parameters<typeof prepareResponsesSidecarAuth>[0];
type State = Parameters<typeof prepareResponsesSidecarAuth>[1];
type Transport = Parameters<typeof prepareResponsesSidecarAuth>[2];

/** One request owns one fallback, including failures and later credential rotations. */
export function createVisionRefusalRecovery(context: Context, state: State, transport: Transport) {
  let attempted = false;
  return async (response: Response, canRetry: boolean | (() => boolean)): Promise<boolean> => {
    if (attempted || context.options.visionDescribeTerminal || context.options.abortSignal?.aborted
      || isNonReplayableResponse(response) || ![400, 415, 422].includes(response.status)
      || !state.parsed.context.messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === "image"))) return false;
    try {
      const body = await readBoundedResponseBody(response.clone(), {
        signal: context.options.abortSignal, maxBytes: 16 * 1024, totalTimeoutMs: 2000,
      });
      if (!body.displaySafe || body.truncated || !isImageCapabilityRefusal(response.status, body.text)) return false;
    } catch { return false; }
    attempted = true;
    const { route } = state;
    rememberVisionRefusal(route.providerName, context.config.providers[route.providerName] ?? route.provider, route.modelId);
    if (context.config.visionSidecar?.enabled === false || !(typeof canRetry === "function" ? canRetry() : canRetry)) return false;
    // Preprocessing owns helper auth, recursion fencing, caching, cancellation and raw-body sync.
    const result = await prepareResponsesSidecarAuth(context, state, transport, { preserveImagesWithoutPlan: true });
    return result.visionPlan !== undefined && !context.options.abortSignal?.aborted;
  };
}
