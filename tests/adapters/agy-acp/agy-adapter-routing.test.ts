import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, AdapterFetchContext, AdapterRequest, IncomingMeta } from "../../../src/adapters/base";
import { withAgyTransport, type AgyTransportDeps } from "../../../src/adapters/agy-acp/adapter";
import type { AgyAccountRef } from "../../../src/adapters/agy-acp/account-home";
import type { AgyBridge } from "../../../src/adapters/agy-acp/bridge-pool";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const AGY_HEADER = { "x-opencodex-antigravity-transport": "agy" };
const DIRECT_HEADER = { "x-opencodex-antigravity-transport": "direct" };
const GOOGLE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

const accounts: AgyAccountRef[] = [
  { id: "acct-a", credential: { access: "fake-token-a", refresh: "fake-refresh-a", expires: Date.now() + 3_600_000 } },
  { id: "acct-b", credential: { access: "fake-token-b", refresh: "fake-refresh-b", expires: Date.now() + 3_600_000 } },
];

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "fake-token-a",
    googleMode: "cloud-code-assist",
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-3.8-flash",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: {},
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(headers: Record<string, string> = {}): IncomingMeta {
  return { headers: new Headers(headers), translatorBudget: createTestTranslatorBudget() };
}

function anthropicMessage(): Response {
  return new Response(JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "gemini-3.8-flash",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

interface Recorded { url: string; body: string }

function fakeBridge(respond: () => Response = anthropicMessage): { bridge: AgyBridge; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    bridge: {
      async fetch(input, init) {
        calls.push({ url: String(input), body: String(init?.body ?? "") });
        return respond();
      },
      async shutdown() {},
    },
  };
}

function depsWith(bridge: AgyBridge): { deps: AgyTransportDeps; bridged: string[] } {
  const bridged: string[] = [];
  return {
    bridged,
    deps: {
      accountForToken: token => accounts.find(account => account.credential.access === token),
      async bridgeFor(account) {
        bridged.push(account.id);
        return bridge;
      },
    },
  };
}

function googleStub(): { adapter: ProviderAdapter; googleRequest: AdapterRequest; googleResponse: Response; buildCalls: number; fetchCalls: Array<{ request: AdapterRequest; ctx?: AdapterFetchContext }> } {
  const googleRequest: AdapterRequest = { url: GOOGLE_URL, method: "POST", headers: { authorization: "Bearer fake" }, body: "{}" };
  const googleResponse = new Response("from google");
  const state = { buildCalls: 0, fetchCalls: [] as Array<{ request: AdapterRequest; ctx?: AdapterFetchContext }> };
  const adapter: ProviderAdapter = {
    name: "google",
    buildRequest() {
      state.buildCalls += 1;
      return googleRequest;
    },
    fetchResponse(request, ctx) {
      state.fetchCalls.push({ request, ctx });
      return Promise.resolve(googleResponse);
    },
    async *parseStream() {},
  };
  return { adapter, googleRequest, googleResponse, get buildCalls() { return state.buildCalls; }, fetchCalls: state.fetchCalls };
}

describe("agy transport routing", () => {
  test("Codex root threads with the same opening instructions have separate bridge identities", async () => {
    const { deps } = depsWith(fakeBridge().bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);
    const first = JSON.parse((await wrapper.buildRequest(parsed({ _codexOwnThreadId: "root-a" }), incoming(AGY_HEADER))).body);
    const second = JSON.parse((await wrapper.buildRequest(parsed({ _codexOwnThreadId: "root-b" }), incoming(AGY_HEADER))).body);
    expect(first.messages).toEqual(second.messages);
    expect(first.metadata?.user_id).toBeString();
    expect(first.metadata.user_id).not.toBe(second.metadata?.user_id);
  });

  test("the parent and own thread pair isolates siblings and children of different parents", async () => {
    const { deps } = depsWith(fakeBridge().bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);
    const identities = await Promise.all([
      { _clientThreadId: "parent-a", _codexOwnThreadId: "child-a" },
      { _clientThreadId: "parent-a", _codexOwnThreadId: "child-b" },
      { _clientThreadId: "parent-b", _codexOwnThreadId: "child-a" },
      { _clientThreadId: "parent-a" },
      { _codexOwnThreadId: "parent-a" },
    ].map(async ids => JSON.parse((await wrapper.buildRequest(parsed(ids), incoming(AGY_HEADER))).body).metadata?.user_id));
    expect(identities.every(id => typeof id === "string")).toBe(true);
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("history growth and retries keep the thread identity; shared cache keys do not identify a thread", async () => {
    const { deps } = depsWith(fakeBridge().bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);
    const ids = { _codexOwnThreadId: "root-a", _clientThreadId: "parent-a" };
    const opening = parsed({ ...ids, options: { promptCacheKey: "cohort-a" } });
    const next = parsed({ ...ids, options: { promptCacheKey: "cohort-b" }, context: { messages: [
      ...opening.context.messages,
      { role: "assistant", content: "ok", timestamp: 1 },
      { role: "user", content: "next", timestamp: 2 },
    ] } });
    const bodies = await Promise.all([opening, next, next].map(async value => JSON.parse((await wrapper.buildRequest(value, incoming(AGY_HEADER))).body)));
    expect(bodies[0].metadata?.user_id).toBeString();
    expect(bodies[1].metadata.user_id).toBe(bodies[0].metadata.user_id);
    expect(bodies[2].metadata.user_id).toBe(bodies[0].metadata.user_id);
    for (const ids of [{}, { _codexOwnThreadId: "  ", _clientThreadId: " " }]) {
      const legacy = await wrapper.buildRequest(parsed({ ...ids, options: { promptCacheKey: "shared-cohort" } }), incoming(AGY_HEADER));
      expect(JSON.parse(legacy.body)).not.toHaveProperty("metadata");
    }
  });

  test("an agy request goes to the bridge of the account holding the provider token, as an Anthropic Messages body", async () => {
    const stub = fakeBridge();
    const { deps, bridged } = depsWith(stub.bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);

    const request = await wrapper.buildRequest(parsed(), incoming(AGY_HEADER));
    const response = await wrapper.fetchResponse!(request);

    expect(bridged).toEqual(["acct-a"]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe("agy://local/v1/messages");
    const body = JSON.parse(stub.calls[0]!.body) as { messages: Array<{ role: string }>; output_config?: unknown };
    expect(body.messages.map(message => message.role)).toEqual(["user"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-opencodex-transport")).toBe("agy");
  });

  test.each([
    ["high", "high"],
    ["minimal", "low"],
  ])("the client's reasoning effort %p becomes output_config.effort %p", async (reasoning, effort) => {
    const stub = fakeBridge();
    const { deps } = depsWith(stub.bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);

    const request = await wrapper.buildRequest(parsed({ options: { reasoning } } as Partial<OcxParsedRequest>), incoming(AGY_HEADER));
    await wrapper.fetchResponse!(request);

    expect((JSON.parse(stub.calls[0]!.body) as { output_config: { effort: string } }).output_config).toEqual({ effort });
  });

  test("client tool schemas reach the bridge cleaned the way the direct transport cleans them", async () => {
    const stub = fakeBridge();
    const { deps } = depsWith(stub.bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);
    const tool = {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          options: { type: "object", properties: { mode: { type: "string" } }, required: ["mode", "mode"] },
        },
        required: ["path", "content", "path", "content", "missing"],
      },
    };

    const request = await wrapper.buildRequest(parsed({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [tool] } } as Partial<OcxParsedRequest>), incoming(AGY_HEADER));
    await wrapper.fetchResponse!(request);

    const sent = (JSON.parse(stub.calls[0]!.body) as { tools: Array<{ name: string; input_schema: Record<string, unknown> }> }).tools;
    const schema = sent.find(entry => entry.name === "write_file")!.input_schema;
    expect(schema.required).toEqual(["path", "content"]);
    expect((schema.properties as { options: { required: string[] } }).options.required).toEqual(["mode"]);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("additionalProperties");
  });

  test("a client that is itself agy does not hand agy its own toolSummary argument a second time", async () => {
    const stub = fakeBridge();
    const { deps } = depsWith(stub.bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider(), deps);
    const tool = {
      name: "run_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { toolSummary: { type: "string" }, CommandLine: { type: "string" } },
        required: ["CommandLine", "toolSummary"],
      },
    };

    const request = await wrapper.buildRequest(parsed({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [tool] } } as Partial<OcxParsedRequest>), incoming(AGY_HEADER));
    await wrapper.fetchResponse!(request);

    const sent = (JSON.parse(stub.calls[0]!.body) as { tools: Array<{ name: string; input_schema: { properties: Record<string, unknown>; required?: string[] } }> }).tools;
    const schema = sent.find(entry => entry.name === "run_command")!.input_schema;
    expect(Object.keys(schema.properties)).toEqual(["CommandLine"]);
    expect(schema.required).toEqual(["CommandLine"]);
  });

  test("a token no pool account holds is refused with 401 and never reaches a bridge", async () => {
    const stub = fakeBridge();
    const { deps, bridged } = depsWith(stub.bridge);
    const wrapper = withAgyTransport(googleStub().adapter, provider({ apiKey: "fake-unknown-token" }), deps);

    const request = await wrapper.buildRequest(parsed(), incoming(AGY_HEADER));
    const response = await wrapper.fetchResponse!(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(bridged).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  test("the direct path hands the request to the Google adapter and returns its results unchanged", async () => {
    const stub = fakeBridge();
    const { deps, bridged } = depsWith(stub.bridge);
    const google = googleStub();
    const wrapper = withAgyTransport(google.adapter, provider({ agyTransport: { enabled: true } }), deps);
    const ctx: AdapterFetchContext = {};

    const request = await wrapper.buildRequest(parsed(), incoming(DIRECT_HEADER));
    expect(request).toBe(google.googleRequest);

    const response = await wrapper.fetchResponse!(request, ctx);
    expect(response).toBe(google.googleResponse);
    expect(google.fetchCalls).toEqual([{ request: google.googleRequest, ctx }]);
    expect(bridged).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  test("with no header and no flag, the Google adapter serves the request", async () => {
    const stub = fakeBridge();
    const { deps, bridged } = depsWith(stub.bridge);
    const google = googleStub();
    const wrapper = withAgyTransport(google.adapter, provider(), deps);

    const request = await wrapper.buildRequest(parsed(), incoming());
    expect(request.url).toBe(GOOGLE_URL);
    expect(await wrapper.fetchResponse!(request)).toBe(google.googleResponse);
    expect(bridged).toEqual([]);
  });
});
