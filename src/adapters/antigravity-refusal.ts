/** Account-scoped Antigravity refusals. Unknown data never convicts an account. */
import { BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";
import { registerProviderResponseProvenance } from "../providers/request-pacing";
import { parseUpstreamJsonPayload } from "./upstream-http-error";
import { ANTIGRAVITY_TOS_VIOLATION_PREFIX } from "./google-errors";

/** Trusted only at the original Google body boundary; never serialized or inferred from display text. */
const modelNotFoundResponses = new WeakMap<Response, AntigravityModelNotFoundEvidence>();
registerProviderResponseProvenance(modelNotFoundResponses);
export const hasAntigravityModelNotFoundProvenance = (response: Response): boolean => modelNotFoundResponses.has(response);

/**
 * `strong`: Google named this very model (ResourceInfo `models/<model>`).
 * `bare`: Google's observed body for a model the account cannot call, the CCA sentence with no
 * detail at all. It cannot tell a missing model from other upstream trouble, so it may rotate the
 * request but is only remembered once a sibling account serves the same model.
 */
export type AntigravityModelNotFoundEvidence = "strong" | "bare";
export const antigravityModelNotFoundEvidence = (response: Response): AntigravityModelNotFoundEvidence | undefined =>
  modelNotFoundResponses.get(response);
const BARE_NOT_FOUND_MESSAGE = /^requested entity was not found\.?$/i;

/** The caller supplies a complete original body, bounded to 4 KiB before normalization. */
export function markAntigravityModelNotFound(response: Response, requestBody: string, payloadText: string): void {
  if (response.status !== 404 || Buffer.byteLength(payloadText, "utf8") > 4096) return;
  const request = parseUpstreamJsonPayload(requestBody) as { model?: unknown } | undefined;
  const payload = parseUpstreamJsonPayload(payloadText) as { error?: {
    code?: unknown; status?: unknown; message?: unknown; details?: unknown;
  } } | undefined;
  const model = request?.model;
  const error = payload?.error;
  if (typeof model !== "string" || !model || !error || error.status !== "NOT_FOUND"
    || (error.code !== undefined && error.code !== 404)) return;
  const details = Array.isArray(error.details) ? error.details : [];
  const resourceInfo = details.filter((detail): detail is Record<string, unknown> =>
    detail !== null && typeof detail === "object" && !Array.isArray(detail)
    && detail["@type"] === "type.googleapis.com/google.rpc.ResourceInfo");
  // Prose naming a model is never evidence; only the exact CCA sentence with no details counts as bare.
  if (!details.length && typeof error.message === "string" && BARE_NOT_FOUND_MESSAGE.test(error.message.trim())) {
    modelNotFoundResponses.set(response, "bare");
    return;
  }
  if (!resourceInfo.length || resourceInfo.some(detail => detail.resourceName !== `models/${model}`
    || (detail.resourceType !== undefined && (typeof detail.resourceType !== "string"
      || !/(?:^|[./])models?$/i.test(detail.resourceType))))) return;
  modelNotFoundResponses.set(response, "strong");
}

export type AntigravityRefusalKind = "verify_account" | "tos_violation" | "other";
export interface AntigravityRefusal { kind: AntigravityRefusalKind }

const VERIFY_ACCOUNT_WORDS = [
  "verify your account",
] as const;

/**
 * Classify an Antigravity (Cloud Code Assist) HTTP refusal.
 *
 * Only the observed 403 verification demand convicts: Google answers
 * `PERMISSION_DENIED` with "Please verify your account to continue using
 * Antigravity." when the account itself is blocked, while the stored OAuth
 * grant (and its refresh) stays valid. Anything else — rate limits, location
 * refusals, malformed or oversized bodies — is "other" and must never mark
 * the account.
 */
export function classifyAntigravityRefusal(status: number, bodyText: string): AntigravityRefusal {
  if (status !== 403) return { kind: "other" };
  if (Buffer.byteLength(bodyText, "utf8") > BOUNDED_BODY_MAX_BYTES)
    return { kind: "other" };
  // The suspension marker exists only when the Google adapter saw a typed TOS_VIOLATION body
  // (google-errors.ts); it leads the normalized text, so upstream prose cannot produce it.
  if (bodyText.startsWith(`${ANTIGRAVITY_TOS_VIOLATION_PREFIX}: `)) return { kind: "tos_violation" };
  const lower = bodyText.toLowerCase();
  if (VERIFY_ACCOUNT_WORDS.some(word => lower.includes(word))) return { kind: "verify_account" };
  return { kind: "other" };
}

/**
 * What one Antigravity 429 says about itself. `quota`: this account's allowance is spent (reason
 * QUOTA_EXHAUSTED or Google's quota wording). `capacity`: the model is overloaded for everyone, so
 * another account cannot help. `declined`: a 429 with no `details` and no retry evidence (the small
 * "Resource has been exhausted (e.g. check quota)." answer Google gives to some request contents):
 * it is the same for every account, so it is returned as is. `unreasoned`: anything else without a
 * known reason; `reasoned` is false when no `ErrorInfo.reason` came with it.
 */
export interface AntigravityRateLimit {
  readonly kind: "quota" | "capacity" | "declined" | "unreasoned";
  readonly reasoned: boolean;
  /** Server-stated wait before this account may be used again (quota reset, else retryDelay). */
  readonly waitSeconds?: number;
  /** `RetryInfo.retryDelay`, for same-account backoff. */
  readonly retryDelaySeconds?: number;
}

const rateLimitResponses = new WeakMap<Response, AntigravityRateLimit>();
registerProviderResponseProvenance(rateLimitResponses);
export const antigravityRateLimit = (response: Response): AntigravityRateLimit | undefined => rateLimitResponses.get(response);

export function classifyAntigravityRateLimit(
  info: { reason?: string; retryDelaySeconds?: number; quotaResetDelaySeconds?: number; hasDetails?: boolean },
  quotaWording: boolean,
  hasRetryEvidence = true,
): AntigravityRateLimit {
  const reasoned = info.reason !== undefined;
  const kind = info.reason === "QUOTA_EXHAUSTED" || (quotaWording && info.reason !== "MODEL_CAPACITY_EXHAUSTED") ? "quota"
    : info.reason === "MODEL_CAPACITY_EXHAUSTED" ? "capacity"
      : !hasRetryEvidence && info.hasDetails === false && !quotaWording ? "declined" : "unreasoned";
  const waitSeconds = info.quotaResetDelaySeconds ?? info.retryDelaySeconds;
  return { kind, reasoned, ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    ...(info.retryDelaySeconds !== undefined ? { retryDelaySeconds: info.retryDelaySeconds } : {}) };
}

export function markAntigravityRateLimit(response: Response, limit: AntigravityRateLimit): void {
  if (response.status === 429) rateLimitResponses.set(response, limit);
}
