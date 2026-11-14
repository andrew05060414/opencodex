import { beforeEach, describe, expect, test } from "bun:test";
import type { AdapterRequest, IncomingMeta } from "../../../src/adapters/base";
import { withAgyTransport, type AgyTransportDeps } from "../../../src/adapters/agy-acp/adapter";
import type { AgyBridge } from "../../../src/adapters/agy-acp/bridge-pool";
import { planAntigravity429Rotation, resetAntigravityRateLimitPolicy } from "../../../src/oauth/antigravity-rate-limit-policy";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const MODEL = "gemini-3.8-flash";
const ACCOUNT = { id: "acct-a", credential: { access: "fake-token-a", refresh: "fake-refresh-a", expires: Date.now() + 3_600_000 } };

beforeEach(() => resetAntigravityRateLimitPolicy());

function provider(): OcxProviderConfig {
  return { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", apiKey: "fake-token-a", googleMode: "cloud-code-assist" } as OcxProviderConfig;
}

function parsed(stream: boolean): OcxParsedRequest {
  return {
    modelId: MODEL,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream,
    options: {},
  } as OcxParsedRequest;
}

function incoming(): IncomingMeta {
  return { headers: new Headers({ "x-opencodex-antigravity-transport": "agy" }), translatorBudget: createTestTranslatorBudget() };
}

const unusedGoogle = {
  name: "google",
  buildRequest: () => ({ url: "https://daily-cloudcode-pa.googleapis.com/x", method: "POST", headers: {}, body: "{}" }),
  fetchResponse: async () => new Response("from google"),
  async *parseStream() {},
};

function bridgeAnswering(respond: () => Response): AgyBridge {
  return { fetch: async () => respond(), shutdown: async () => {} };
}

function depsWith(bridge: AgyBridge): AgyTransportDeps {
  return {
    accountForToken: token => (token === ACCOUNT.credential.access ? ACCOUNT : undefined),
    bridgeFor: async () => bridge,
  };
}

async function callAgy(bridge: AgyBridge, stream: boolean): Promise<{ request: AdapterRequest; response: Response; wrapper: ReturnType<typeof withAgyTransport> }> {
  const wrapper = withAgyTransport(unusedGoogle as never, provider(), depsWith(bridge));
  const request = await wrapper.buildRequest(parsed(stream), incoming());
  const response = await wrapper.fetchResponse!(request);
  return { request, response, wrapper };
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json" } });
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const messageStart: [string, unknown] = ["message_start", {
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
}];
const textStart: [string, unknown] = ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
const textDelta: [string, unknown] = ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }];
const blockStop: [string, unknown] = ["content_block_stop", { type: "content_block_stop", index: 0 }];
const messageDelta: [string, unknown] = ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }];
const messageStop: [string, unknown] = ["message_stop", { type: "message_stop" }];

function streamError(type: string, message: string): [string, unknown] {
  return ["error", { type: "error", error: { type, message } }];
}

describe("agy 429 mapping and rotation", () => {
  test("a bridge 429 that says the credit balance is too low rotates the account", async () => {
    const message = "agy bridge: Antigravity AI credits balance is too low to continue: fake detail";
    const { response } = await callAgy(bridgeAnswering(() => jsonError(429, "rate_limit_error", message)), false);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-transport")).toBe("agy");
    expect(planAntigravity429Rotation({}, response, ACCOUNT.id, MODEL)).toMatchObject({ rotate: true });
  });

  test("a quota error inside a 200 stream, before any content, is a 429 that rotates", async () => {
    const message = "agy bridge: Antigravity quota or rate limit reached: RESOURCE_EXHAUSTED";
    const body = sse([messageStart, streamError("rate_limit_error", message)]);
    const { response } = await callAgy(bridgeAnswering(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })), true);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-transport")).toBe("agy");
    expect(planAntigravity429Rotation({}, response, ACCOUNT.id, MODEL)).toMatchObject({ rotate: true });
  });

  test("a non-quota rate limit is a 429 that does not rotate", async () => {
    const message = "agy bridge: too many requests, slow down";
    const { response } = await callAgy(bridgeAnswering(() => jsonError(429, "rate_limit_error", message)), false);

    expect(response.status).toBe(429);
    expect(planAntigravity429Rotation({}, response, ACCOUNT.id, MODEL)).toMatchObject({ rotate: false, declined: true });
  });

  test("a pre-content invalid_request_error in the stream is a 400", async () => {
    const body = sse([streamError("invalid_request_error", "agy bridge: the request is malformed")]);
    const { response } = await callAgy(bridgeAnswering(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })), true);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });

  test("a healthy stream reaches the client byte for byte, and parses to its text", async () => {
    const body = sse([messageStart, textStart, textDelta, blockStop, messageDelta, messageStop]);
    const upstreamBytes = new TextEncoder().encode(body);
    const stream = () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

    const { response, wrapper } = await callAgy(bridgeAnswering(stream), true);
    expect(response.headers.get("x-opencodex-transport")).toBe("agy");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);

    const { response: second } = await callAgy(bridgeAnswering(stream), true);
    const events = [];
    for await (const event of wrapper.parseStream(second, createTestTranslatorBudget())) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", text: "Hello" });
  });
});
