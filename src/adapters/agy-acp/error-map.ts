import { classifyAntigravityRateLimit, markAntigravityRateLimit } from "../antigravity-refusal";
import { isGoogleQuotaExhaustedText, isQuotaExhaustedBody, parseGoogleRateLimitInfo } from "../google-errors";

/** Marks a response that came through the agy bridge, so parsers and error formatters pick the Anthropic shape. */
export const AGY_RESPONSE_HEADER = "x-opencodex-transport";
export const AGY_RESPONSE_MARK = "agy";

const STATUS_BY_ERROR_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  overloaded_error: 503,
  api_error: 503,
};

/** Status for a pre-content SSE error, which arrives on an HTTP 200 stream. */
export function agyStatusForErrorType(errorType: string | undefined): number {
  return (errorType && STATUS_BY_ERROR_TYPE[errorType]) || 502;
}

const QUOTA_WORDING = /quota|credit/i;

/**
 * The Google 429 body the pool classifies. Quota or credit wording becomes QUOTA_EXHAUSTED, which
 * rotates. Any other rate-limit message has no details, so it classifies as declined and stays put.
 */
export function antigravityRateLimitBody(message: string): string {
  const quota = QUOTA_WORDING.test(message);
  return JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: quota ? `Antigravity quota exhausted: ${message}` : `Antigravity rate limit: ${message}`,
      ...(quota ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", domain: "agy-acp" }] } : {}),
    },
  });
}

export function agyErrorBody(errorType: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type: errorType, message } });
}

export function agyJsonResponse(status: number, body: string, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  merged.set(AGY_RESPONSE_HEADER, AGY_RESPONSE_MARK);
  return new Response(body, { status, headers: merged });
}

/** An error the bridge reported, in the shape the policies read: a 429 rate limit, or a plain status. */
export function agyErrorResponse(input: { status: number; errorType?: string; message: string; rawBody: string }): Response {
  if (input.errorType === "rate_limit_error" || input.status === 429) {
    const body = antigravityRateLimitBody(input.message);
    const response = agyJsonResponse(429, body);
    markAntigravityRateLimit(response, classifyAntigravityRateLimit(
      parseGoogleRateLimitInfo(body),
      isQuotaExhaustedBody(body) || isGoogleQuotaExhaustedText(body),
    ));
    return response;
  }
  return agyJsonResponse(input.status, input.rawBody);
}
