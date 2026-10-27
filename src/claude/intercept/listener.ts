import type { Server } from "bun";
import { cliCatalogKind, rewriteCliCatalogResponse, type CliCatalogKind } from "./cli-catalog";
import type { PemKeyPair } from "./local-ca";
import type { PickerModelEntry } from "./picker-bootstrap";

/**
 * TLS listener that terminates intercepted `api.anthropic.com` tunnels.
 *
 * The CONNECT proxy splices a Claude Code tunnel onto this socket; the client then speaks
 * HTTPS believing it reached Anthropic. Messages traffic is rewritten to a loopback URL and
 * handed to the router's own request handler, which already knows how to route mapped models
 * to providers and pass genuine Claude models through with the caller's subscription
 * credential. Every other path (usage, feedback, model listings, …) is relayed verbatim to
 * the real upstream so the client keeps behaving like a first-party install. The one exception
 * is the Claude Code CLI's own picker catalog, which `cliCatalog` may extend (cli-catalog.ts).
 */

export const CLAUDE_INTERCEPT_UPSTREAM = "https://api.anthropic.com";

const INTERCEPTED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "host", "content-length",
  "accept-encoding",
]);

// fetch() transparently decodes the body, so the encoding headers would describe bytes the
// client never sees.
const RESPONSE_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length",
]);

export function isClaudeInterceptedPath(pathname: string, method: string): boolean {
  return method === "POST" && INTERCEPTED_PATHS.has(pathname);
}

/**
 * Rebuild the request as if the client had dialled the router directly on loopback: the
 * admission and Host checks then take the same path a plain loopback bind always has.
 */
export function rewriteInterceptedRequest(req: Request, loopbackOrigin: string): Request {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("host", loopbackOrigin.replace(/^https?:\/\//, ""));
  return new Request(`${loopbackOrigin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    redirect: "manual",
    // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
    duplex: "half",
  });
}

export function forwardHeadersForUpstream(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

/**
 * Relay one request to the real upstream verbatim, unless `bodyOverride` is given -- used by
 * `relayInterceptedMessagesToUpstream` below to send a REDACTED body instead of the client's
 * original bytes, with a `content-length` that matches what is actually sent.
 */
export async function relayToUpstream(
  req: Request,
  upstreamBase: string,
  fetchImpl: typeof fetch = fetch,
  bodyOverride?: Uint8Array,
): Promise<Response> {
  const url = new URL(req.url);
  const target = `${upstreamBase.replace(/\/$/, "")}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const headers = forwardHeadersForUpstream(req.headers);
  if (bodyOverride) headers.set("content-length", String(bodyOverride.byteLength));
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers,
      body: (bodyOverride ?? (hasBody ? req.body : undefined)) as BodyInit | undefined,
      signal: req.signal,
      redirect: "manual",
      // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
      duplex: "half",
    });
  } catch (error) {
    return Response.json(
      { type: "error", error: { type: "api_error", message: `intercept relay failed: ${error instanceof Error ? error.message : String(error)}` } },
      { status: 502 },
    );
  }
  const headers2 = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) headers2.append(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: headers2 });
}

function privacyRelayRefusal(detail: string): Response {
  return Response.json(
    { type: "error", error: { type: "api_error", message: `privacy redaction failed; request was not sent: ${detail}` } },
    { status: 503 },
  );
}

/**
 * Privacy redaction (privacy_contract.md), for the ONE path that used to bypass it entirely:
 * when a client's traffic is classified `relay-native` (see client-class.ts), `/v1/messages`
 * and `/v1/messages/count_tokens` never reach the router (and therefore never reach
 * `claude-messages.ts`'s own redaction) -- `relayToUpstream` sent the client's original bytes
 * straight to `api.anthropic.com`. This reads the body, redacts it with the SAME Anthropic
 * Messages redactor, and relays the redacted bytes with a corrected `content-length` instead.
 *
 * Fail closed: a request body carrying `content-encoding` is never decoded here (there is no
 * decoder in this module), and a redaction failure never falls through to relaying the
 * original body -- both return 503 without calling `fetchImpl`. The response is never touched
 * (redaction is one-way).
 */
export async function relayInterceptedMessagesToUpstream(
  req: Request,
  upstreamBase: string,
  redact: (body: unknown) => unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (req.headers.has("content-encoding")) {
    return privacyRelayRefusal("request body content-encoding is not supported");
  }
  let bytes: Uint8Array;
  try {
    const raw = await req.text();
    const parsed = raw.length > 0 ? JSON.parse(raw) : null;
    bytes = new TextEncoder().encode(JSON.stringify(redact(parsed)));
  } catch (error) {
    return privacyRelayRefusal(error instanceof Error ? error.message : String(error));
  }
  return relayToUpstream(req, upstreamBase, fetchImpl, bytes);
}

export interface ClaudeInterceptListenerOptions<T = undefined> {
  leaf: PemKeyPair;
  /** Router request handler; receives the loopback-rewritten request and the intercept server. */
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  /** Per-request decision for every path; absent preserves the existing path split. */
  route?: (req: Request) => "router" | "relay-native";
  /**
   * Rows to merge into a relayed Claude Code CLI picker catalog, or null to relay it unchanged.
   * Consulted for every catalog GET, including ones `route` sends to the native upstream.
   */
  cliCatalog?: (req: Request, kind: CliCatalogKind) => Promise<readonly PickerModelEntry[] | null>;
  upstreamBase?: string;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
  /**
   * Redacts an Anthropic Messages body (privacy_contract.md) before a `relay-native` send for
   * `/v1/messages` or `/v1/messages/count_tokens` bypasses the router entirely. Absent means
   * redaction is off (matches `config.privacy.enabled` being off). Throwing is fail-closed:
   * the caller returns 503 instead of relaying the original body.
   */
  redactMessagesBody?: (body: unknown) => unknown;
}

/** Bind the intercept TLS listener on an ephemeral loopback port. */
export function startClaudeInterceptListener<T = undefined>(options: ClaudeInterceptListenerOptions<T>): Server<T> {
  const upstreamBase = options.upstreamBase ?? CLAUDE_INTERCEPT_UPSTREAM;
  let loopbackOrigin = "";
  const server = Bun.serve<T>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    tls: { cert: options.leaf.certPem, key: options.leaf.keyPem },
    idleTimeout: options.idleTimeout ?? 255,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
    async fetch(req, requestServer) {
      const url = new URL(req.url);
      const native = options.route?.(req) === "relay-native";
      if (!native && isClaudeInterceptedPath(url.pathname, req.method)) {
        return options.dispatch(rewriteInterceptedRequest(req, loopbackOrigin), requestServer);
      }
      const upstream = native ? CLAUDE_INTERCEPT_UPSTREAM : upstreamBase;
      if (native && options.redactMessagesBody && isClaudeInterceptedPath(url.pathname, req.method)) {
        return relayInterceptedMessagesToUpstream(req, upstream, options.redactMessagesBody, options.fetchImpl);
      }
      const catalog = options.cliCatalog ? cliCatalogKind(req.method, url.pathname) : null;
      if (catalog) {
        let models: readonly PickerModelEntry[] | null = null;
        try { models = await options.cliCatalog!(req, catalog); } catch { /* Fail open: relay unchanged. */ }
        if (models && models.length > 0) {
          return rewriteCliCatalogResponse(await relayToUpstream(req, upstream, options.fetchImpl), catalog, models);
        }
      }
      return relayToUpstream(req, upstream, options.fetchImpl);
    },
  });
  loopbackOrigin = `http://127.0.0.1:${server.port}`;
  return server;
}
