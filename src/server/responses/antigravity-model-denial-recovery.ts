import { getConfigDir } from "../../config/paths";
import type { OAuthAccessSnapshot } from "../../oauth";
import { failoverAccountSnapshot, rotateAntigravityAccountOnModelNotFound } from "../../oauth/generic-account-failover";
import {
  ANTIGRAVITY_BARE_MODEL_DENIAL_TTL_MS, captureAntigravityModelObservation, recordAntigravityModelDenial,
  type AntigravityModelObservation,
} from "../../providers/antigravity-account-roster";
import { isNonReplayableResponse, SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { OcxConfig } from "../../types";
import type { ResponsesSendBudget } from "./request-send-budget";
import { antigravityModelNotFoundStrength } from "./antigravity-validation-refusal";

/** Common guarded credential-hop lifecycle for Antigravity auth and model recovery. */
export async function recoverAntigravityAccount(options: {
  nextId: string; failedResponse: Response;
  reserve: () => ReturnType<ResponsesSendBudget["reserveCredentialHop"]>;
  applyFailoverSnapshot: (snapshot: OAuthAccessSnapshot) => Promise<OAuthAccessSnapshot | null | undefined>;
  prepare: () => void;
  refetch: (onDispatch: () => void) => Promise<Response | { failed: Response }>;
  adapterOwnsDispatch: boolean;
  setPermit: (permit: ResponsesSendBudget["pendingHopPermit"]) => void;
  complete: () => void;
}): Promise<Response | null> {
  const hop = options.reserve();
  if (!hop.allowed) return null;
  try {
    const snapshot = await failoverAccountSnapshot("google-antigravity", options.nextId);
    if ((await options.applyFailoverSnapshot(snapshot))?.accountId !== options.nextId) return null;
    options.prepare();
    options.setPermit(hop.permit);
    const result = await options.refetch(() => {
      if (!options.adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
    });
    if ("failed" in result) return result.failed === options.failedResponse ? null : result.failed;
    options.complete();
    try { void options.failedResponse.body?.cancel().catch(() => {}); } catch { /* already closed */ }
    return result;
  } catch { return null; }
  finally { options.setPermit(undefined); hop.permit?.release(); }
}

/** Request-local ordering fence and attempted-account set; never infer exhaustion from a failed hop. */
export function createAntigravityModelDenialRecovery() {
  const root = getConfigDir();
  let observation = captureAntigravityModelObservation();
  const attempted = new Set<string>();
  // Bare 404s are remembered only once a sibling account serves the same model: if every account
  // answers the same bare 404 the model name (or the client fingerprint) is at fault, not the accounts.
  const pendingBare: { accountId: string; observation: AntigravityModelObservation & { generation: string } }[] = [];
  let exhaustion: "none" | "ineligible" | "recovery" = "none";
  return {
    beforeSend: () => { observation = captureAntigravityModelObservation(); },
    async recover(response: Response, sent: Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined, context: {
      config: OcxConfig; model: string | null | undefined; enabled: boolean; remaining: boolean;
      signal?: AbortSignal; rotate: (id: string) => Promise<Response | null>;
    }): Promise<Response | null> {
      if (pendingBare.length && context.model && response.status >= 200 && response.status < 400) {
        for (const row of pendingBare.splice(0)) {
          recordAntigravityModelDenial("google-antigravity", row.accountId, context.model, row.observation, Date.now(),
            ANTIGRAVITY_BARE_MODEL_DENIAL_TTL_MS);
        }
      }
      const strength = antigravityModelNotFoundStrength(response, context.signal);
      if (!context.enabled || !sent || !context.model || !strength || isNonReplayableResponse(response)) return null;
      // Capture BEFORE the bounded response read: another discovery can finish during it.
      const sentObservation = { ...observation, configDir: root, generation: sent.generation };
      if (getConfigDir() !== root) return null;
      if (strength === "strong") {
        if (!recordAntigravityModelDenial("google-antigravity", sent.accountId, context.model, sentObservation)) return null;
      } else pendingBare.push({ accountId: sent.accountId, observation: sentObservation });
      attempted.add(sent.accountId);
      const next = rotateAntigravityAccountOnModelNotFound(context.config, sent.accountId, context.model, attempted);
      if (!next) { exhaustion = "ineligible"; return null; }
      if (!context.remaining) { exhaustion = "recovery"; return null; }
      const result = await context.rotate(next);
      exhaustion = result ? "none" : "recovery";
      return result;
    },
    message(model: string | null | undefined, fallback: string): string {
      return exhaustion === "ineligible"
        ? `No eligible stored Google Antigravity account can serve the model "${model}". ${fallback}`
        : exhaustion === "recovery"
          ? `Google Antigravity could not recover the model "${model}": an eligible account could not be resolved, admitted, or sent within the request budget. ${fallback}`
          : fallback;
    },
  };
}
