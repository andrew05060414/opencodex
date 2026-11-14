import { describe, expect, test } from "bun:test";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "../../../src/adapters/base";
import { withAgyTransport } from "../../../src/adapters/agy-acp/adapter";
import type { AgyBridge } from "../../../src/adapters/agy-acp/bridge-pool";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const ACCOUNT = { id: "acct-a", credential: { access: "fake-token-a", refresh: "fake-refresh-a", expires: Date.now() + 3_600_000 } };

const unusedGoogle = {
  name: "google",
  buildRequest: () => ({ url: "https://daily-cloudcode-pa.googleapis.com/x", method: "POST", headers: {}, body: "{}" }),
  fetchResponse: async () => new Response("from google"),
  async *parseStream() {},
} as unknown as ProviderAdapter;

function provider(): OcxProviderConfig {
  return { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", apiKey: "fake-token-a", googleMode: "cloud-code-assist" } as OcxProviderConfig;
}

function parsed(): OcxParsedRequest {
  return { modelId: "gemini-3.8-flash", context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, stream: false, options: {} } as OcxParsedRequest;
}

function incoming(): IncomingMeta {
  return { headers: new Headers({ "x-opencodex-antigravity-transport": "agy" }), translatorBudget: createTestTranslatorBudget() };
}

/** Answers each attempt with the next status; the last status repeats once the list runs out. */
function bridgeAnsweringInOrder(statuses: number[]): { bridge: AgyBridge; attempts: () => number } {
  let attempts = 0;
  const bridge: AgyBridge = {
    async fetch() {
      const status = statuses[Math.min(attempts, statuses.length - 1)]!;
      attempts += 1;
      if (status === 200) {
        return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "gemini-3.8-flash", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "agy bridge: no active MCP call matches these tool results" } }), { status, headers: { "content-type": "application/json" } });
    },
    async shutdown() {},
  };
  return { bridge, attempts: () => attempts };
}

async function fetchVia(bridge: AgyBridge, ctx?: AdapterFetchContext): Promise<Response> {
  const wrapper = withAgyTransport(unusedGoogle, provider(), {
    accountForToken: token => (token === ACCOUNT.credential.access ? ACCOUNT : undefined),
    bridgeFor: async () => bridge,
  });
  const request: AdapterRequest = await wrapper.buildRequest(parsed(), incoming());
  return wrapper.fetchResponse!(request, ctx);
}

describe("agy bridge 409 conflict retry", () => {
  test("a conflict that clears on the third attempt returns that attempt's 200", async () => {
    const stub = bridgeAnsweringInOrder([409, 409, 200]);

    const response = await fetchVia(stub.bridge);

    expect(response.status).toBe(200);
    expect(stub.attempts()).toBe(3);
  }, 10_000);

  test("a conflict that persists returns the last 409 after exactly three attempts", async () => {
    const stub = bridgeAnsweringInOrder([409]);

    const response = await fetchVia(stub.bridge);

    expect(response.status).toBe(409);
    expect(stub.attempts()).toBe(3);
  }, 10_000);

  test("an abort during the wait stops further attempts", async () => {
    const stub = bridgeAnsweringInOrder([409]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const response = await fetchVia(stub.bridge, { abortSignal: controller.signal });

    expect(response.status).toBe(409);
    expect(stub.attempts()).toBe(1);
  }, 10_000);
});
