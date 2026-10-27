/**
 * Privacy redaction (privacy_contract.md) for the Claude intercept listener's relay-native
 * lane: a client classified `relay-native` (client-class.ts) never reaches the router for
 * `/v1/messages` / `/v1/messages/count_tokens`, so `claude-messages.ts`'s own redaction mount
 * never runs either -- this is the gap `relayInterceptedMessagesToUpstream` closes.
 *
 * `picker-listener.ts` (Claude Desktop's private claude.ai interface) is explicitly NOT
 * covered by this change -- see the backend handoff report.
 */
import { afterAll, expect, test } from "bun:test";
import {
  isClaudeInterceptedPath,
  relayInterceptedMessagesToUpstream,
  relayToUpstream,
  startClaudeInterceptListener,
} from "../../src/claude/intercept/listener";
import { CLAUDE_INTERCEPT_HOSTS, startConnectProxy, type ConnectProxyHandle } from "../../src/claude/intercept/connect-proxy";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { isPrivacyRedactionEnabled, privacyOptionsFromConfig, redactClientBody } from "../../src/privacy";
import { anthropicBodyFixture, THINKING_BLOCK_SECRET } from "../privacy/fixtures/bodies";
import { fakeOpenAiKey } from "../privacy/fixtures/secrets";
import type { OcxConfig } from "../../src/types";

interface FakeUpstream { url: string; bodies: Array<{ text: string; headers: Headers }>; stop: () => void }
function fakeUpstream(): FakeUpstream {
  const bodies: Array<{ text: string; headers: Headers }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      bodies.push({ text: await req.text(), headers: req.headers });
      return Response.json({ type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "ok" }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) };
}

function redactFn(config: OcxConfig): (body: unknown) => unknown {
  return (body: unknown) => redactClientBody(body, privacyOptionsFromConfig(config)).body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

test("isClaudeInterceptedPath matches only POST /v1/messages and /v1/messages/count_tokens", () => {
  expect(isClaudeInterceptedPath("/v1/messages", "POST")).toBe(true);
  expect(isClaudeInterceptedPath("/v1/messages/count_tokens", "POST")).toBe(true);
  expect(isClaudeInterceptedPath("/v1/messages", "GET")).toBe(false);
  expect(isClaudeInterceptedPath("/v1/usage", "POST")).toBe(false);
});

test("relayInterceptedMessagesToUpstream: the fake upstream never sees the fake secret, signature survives byte-for-byte", async () => {
  const upstream = fakeUpstream();
  try {
    const config = { privacy: { enabled: true }, providers: {} } as unknown as OcxConfig;
    const apiKey = fakeOpenAiKey("intercept-relay-native");
    const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
    const req = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-ant-oat01-fixture" },
      body: JSON.stringify(body),
    });
    const response = await relayInterceptedMessagesToUpstream(req, upstream.url, redactFn(config));
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.bodies).toHaveLength(1);
    const sentText = upstream.bodies[0]!.text;
    expect(sentText).not.toContain(apiKey);
    expect(upstream.bodies[0]!.headers.get("content-length")).toBe(String(Buffer.byteLength(sentText)));
    const sent = asRecord(JSON.parse(sentText));
    const messages = sent.messages as Array<Record<string, unknown>>;
    const thinkingBlock = (messages[1]!.content as Array<Record<string, unknown>>)[0]!;
    expect(thinkingBlock.signature).toBe("fixture-signature-abc123");
    expect(thinkingBlock.thinking).toBe(`secret reasoning about ${THINKING_BLOCK_SECRET}`);
  } finally { upstream.stop(); }
});

test("relayInterceptedMessagesToUpstream: fail closed on content-encoding, never calls fetchImpl", async () => {
  const upstream = fakeUpstream();
  let fetchCalled = false;
  try {
    const config = { privacy: { enabled: true }, providers: {} } as unknown as OcxConfig;
    const req = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Buffer.from([0x1f, 0x8b]),
    });
    const spyFetch = (async (...args: Parameters<typeof fetch>) => { fetchCalled = true; return fetch(...args); }) as typeof fetch;
    const response = await relayInterceptedMessagesToUpstream(req, upstream.url, redactFn(config), spyFetch);
    expect(response.status).toBe(503);
    expect(fetchCalled).toBe(false);
    expect(upstream.bodies).toHaveLength(0);
  } finally { upstream.stop(); }
});

test("relayInterceptedMessagesToUpstream: fail closed when the redactor throws, never calls fetchImpl", async () => {
  const upstream = fakeUpstream();
  let fetchCalled = false;
  try {
    const req = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    const throwingRedact = () => { throw new Error("fixture redaction failure"); };
    const spyFetch = (async (...args: Parameters<typeof fetch>) => { fetchCalled = true; return fetch(...args); }) as typeof fetch;
    const response = await relayInterceptedMessagesToUpstream(req, upstream.url, throwingRedact, spyFetch);
    expect(response.status).toBe(503);
    expect(fetchCalled).toBe(false);
    expect(upstream.bodies).toHaveLength(0);
  } finally { upstream.stop(); }
});

test("relayToUpstream with no bodyOverride still relays a GET verbatim (regression guard)", async () => {
  const upstream = fakeUpstream();
  try {
    const req = new Request("https://api.anthropic.com/v1/usage", { method: "GET" });
    const response = await relayToUpstream(req, upstream.url);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]!.text).toBe("");
  } finally { upstream.stop(); }
});

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/**
 * Full wire test: a `relay-native`-classified client's Messages traffic through the real
 * CONNECT + TLS intercept pair never reaches ITS destination with the fake secret intact.
 *
 * `relay-native` always targets the REAL `api.anthropic.com` (by design: it exists for a
 * genuine first-party client that must not be touched otherwise), so the fake-upstream-via-
 * `upstreamBase` trick the other end-to-end tests use does not apply here -- `upstreamBase` is
 * for the non-native lane only. This captures what the listener would actually have sent, via
 * `fetchImpl`, instead of letting it dial the real network.
 */
test("end-to-end through the intercept pair: relay-native Messages traffic is redacted before it is sent", async () => {
  const AUTH_TOKEN = "fixture-proxy-token";
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  const config = { privacy: { enabled: true }, providers: {} } as unknown as OcxConfig;
  const captured: Array<{ url: string; body: string }> = [];
  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sentBody = typeof init?.body === "string" ? init.body
      : init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "";
    captured.push({ url: String(input), body: sentBody });
    return Response.json({ type: "message", id: "msg_fixture", role: "assistant", content: [] });
  }) as typeof fetch;
  const listener = startClaudeInterceptListener({
    leaf,
    dispatch: async () => Response.json({ shouldNotBeDispatched: true }),
    route: () => "relay-native",
    fetchImpl: capturingFetch,
    redactMessagesBody: isPrivacyRedactionEnabled(config) ? redactFn(config) : undefined,
  });
  cleanups.push(() => listener.stop(true));
  const proxy: ConnectProxyHandle = await startConnectProxy(0, {
    interceptPort: listener.port!,
    authToken: AUTH_TOKEN,
  });
  cleanups.push(() => proxy.close());
  const apiKey = fakeOpenAiKey("intercept-e2e");
  const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-oat01-fixture" },
    body: JSON.stringify(body),
    proxy: `http://opencodex:${AUTH_TOKEN}@127.0.0.1:${proxy.port}`,
    tls: { ca: ca.certPem },
  } as RequestInit);
  expect(res.status).toBe(200);
  await res.text();
  expect(captured).toHaveLength(1);
  expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(captured[0]!.body).not.toContain(apiKey);
});
