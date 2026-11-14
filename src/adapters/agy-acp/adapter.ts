import type { OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { createAnthropicAdapter } from "../anthropic";
import { safeAntigravityHttpErrorMessage } from "../google-errors";
import { listAccounts } from "../../oauth/store";
import { agyAccountHome, ensureAgyTokenFile, type AgyAccountRef } from "./account-home";
import { defaultAgyBridgePool, type AgyBridge } from "./bridge-pool";
import { agyErrorBody, agyErrorResponse, AGY_RESPONSE_HEADER, AGY_RESPONSE_MARK, agyJsonResponse, agyStatusForErrorType } from "./error-map";
import { peekAgyStream } from "./stream-peek";
import { chooseAntigravityTransport } from "./transport";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
/** The Anthropic adapter needs a base URL, and the bridge ignores it, so it names no host. */
const AGY_PLACEHOLDER_URL = "agy://local";
const NO_ACCOUNT_MESSAGE = "agy transport: no Antigravity pool account holds this token";
const DROPPED_UPSTREAM_HEADERS = new Set(["x-api-key", "authorization", "x-goog-api-key", "content-length"]);

export interface AgyTransportDeps {
  accountForToken(accessToken: string): AgyAccountRef | undefined;
  bridgeFor(account: AgyAccountRef, agyPath: string | undefined): Promise<AgyBridge>;
}

export function defaultAgyTransportDeps(): AgyTransportDeps {
  return {
    accountForToken: accessToken => listAccounts(ANTIGRAVITY_PROVIDER_ID).find(account => account.credential.access === accessToken),
    bridgeFor: async (account, agyPath) => {
      const home = agyAccountHome(account.id);
      await ensureAgyTokenFile(account, home);
      return defaultAgyBridgePool().bridgeFor(account.id, home, agyPath);
    },
  };
}

/** The agy request is the only one addressed to the placeholder; a Google request always has a real host. */
function isAgyRequest(request: AdapterRequest): boolean {
  return request.url.startsWith(`${AGY_PLACEHOLDER_URL}/`);
}

function isAgyHeaders(headers: Headers): boolean {
  return headers.get(AGY_RESPONSE_HEADER) === AGY_RESPONSE_MARK;
}

function forwardedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_UPSTREAM_HEADERS.has(name.toLowerCase())));
}

function parseErrorPayload(text: string): { errorType: string | undefined; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    return {
      errorType: typeof parsed.error?.type === "string" ? parsed.error.type : undefined,
      message: typeof parsed.error?.message === "string" ? parsed.error.message : text,
    };
  } catch {
    return { errorType: undefined, message: text };
  }
}

/** The bridge answers 409 until agy registers a tool call, and a repeat attempt resolves it. */
const CONFLICT_ATTEMPTS = 3;
const CONFLICT_RETRY_DELAY_MS = 750;

function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function fetchThroughBridge(bridge: AgyBridge, request: AdapterRequest, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = {
    method: request.method,
    headers: forwardedHeaders(request.headers),
    body: request.body,
    ...(signal ? { signal } : {}),
  };
  let upstream = await bridge.fetch(request.url, init);
  for (let attempt = 1; upstream.status === 409 && attempt < CONFLICT_ATTEMPTS; attempt++) {
    await waitUnlessAborted(CONFLICT_RETRY_DELAY_MS, signal);
    if (signal?.aborted) break;
    await upstream.body?.cancel().catch(() => {});
    upstream = await bridge.fetch(request.url, init);
  }
  return upstream;
}

/**
 * Give one Google-antigravity provider a per-request transport. `direct` delegates to the Google
 * adapter untouched. `agy` builds the request as Anthropic Messages, sends it through the bridge
 * for the account the pool picked, and parses the Anthropic response. Both paths keep the
 * providerName, so the account pool, rotation and quota policies see the same provider.
 */
export function withAgyTransport(
  google: ProviderAdapter,
  provider: OcxProviderConfig,
  deps: AgyTransportDeps = defaultAgyTransportDeps(),
  cacheRetention?: "none" | "short" | "long",
): ProviderAdapter {
  const anthropic = createAnthropicAdapter({
    ...provider,
    baseUrl: AGY_PLACEHOLDER_URL,
    apiKey: "agy",
    authMode: undefined,
  }, cacheRetention);
  const googleFetch = google.fetchResponse;

  async function buildAgyRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
    const request = await anthropic.buildRequest(parsed, incoming);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const effort = parsed.options.reasoning;
    if (body.output_config === undefined && effort && effort !== "none") {
      body.output_config = { effort: effort === "minimal" ? "low" : effort };
    }
    return { ...request, body: JSON.stringify(body) };
  }

  async function fetchAgy(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
    const streamRequested = (JSON.parse(request.body) as { stream?: unknown }).stream === true;
    const account = deps.accountForToken(provider.apiKey ?? "");
    if (!account) {
      return agyErrorResponse({ status: 401, errorType: "authentication_error", message: NO_ACCOUNT_MESSAGE, rawBody: agyErrorBody("authentication_error", NO_ACCOUNT_MESSAGE) });
    }
    const bridge = await deps.bridgeFor(account, provider.agyTransport?.agyPath);
    const upstream = await fetchThroughBridge(bridge, request, ctx?.abortSignal);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      const parsed = parseErrorPayload(text);
      return agyErrorResponse({ status: upstream.status, errorType: parsed.errorType, message: parsed.message, rawBody: text });
    }
    const isStream = streamRequested || (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isStream) return agyJsonResponse(upstream.status, await upstream.text());
    const peeked = await peekAgyStream(upstream, ctx?.abortSignal);
    if (peeked.kind === "error") {
      return agyErrorResponse({
        status: agyStatusForErrorType(peeked.errorType),
        errorType: peeked.errorType,
        message: peeked.message,
        rawBody: peeked.data,
      });
    }
    return peeked.response;
  }

  return {
    ...google,

    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      if (chooseAntigravityTransport(provider, incoming.headers) !== "agy") return google.buildRequest(parsed, incoming);
      return buildAgyRequest(parsed, incoming);
    },

    ...(googleFetch ? {
      fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
        return isAgyRequest(request) ? fetchAgy(request, ctx) : googleFetch.call(google, request, ctx);
      },
    } : {}),

    async *parseStream(response, budget, tierMetadata, streamContext) {
      if (isAgyHeaders(response.headers)) {
        yield* anthropic.parseStream(response, budget, tierMetadata, streamContext);
        return;
      }
      yield* google.parseStream(response, budget);
    },

    ...(google.parseResponse ? {
      parseResponse(response, budget, tierMetadata) {
        if (isAgyHeaders(response.headers) && anthropic.parseResponse) return anthropic.parseResponse(response, budget, tierMetadata);
        return google.parseResponse!(response, budget);
      },
    } : {}),

    ...(google.formatErrorBody ? {
      formatErrorBody(status: number, headers: Headers, payloadText: string): string {
        if (!isAgyHeaders(headers)) return google.formatErrorBody!(status, headers, payloadText);
        if (status === 429) return safeAntigravityHttpErrorMessage(status, payloadText);
        return anthropic.formatErrorBody?.(status, headers, payloadText) ?? payloadText;
      },
    } : {}),
  };
}
