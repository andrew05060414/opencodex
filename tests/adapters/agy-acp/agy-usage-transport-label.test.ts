import { describe, expect, test } from "bun:test";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../../../src/adapters/base";
import { withAgyTransport, type AgyTransportDeps } from "../../../src/adapters/agy-acp/adapter";
import { beginRequestAttempt, type RequestLogContext } from "../../../src/server/request-log";
import { recordAdapterTransport } from "../../../src/server/request-log-antigravity-transport";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../../src/usage/log";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const GOOGLE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

function provider(agyEnabled?: boolean): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "fake-token",
    googleMode: "cloud-code-assist",
    ...(agyEnabled === undefined ? {} : { agyTransport: { enabled: agyEnabled } }),
  } as OcxProviderConfig;
}

const parsed = {
  modelId: "gemini-3.8-flash",
  context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  stream: false,
  options: {},
} as unknown as OcxParsedRequest;

function incoming(headers: Record<string, string> = {}): IncomingMeta {
  return { headers: new Headers(headers), translatorBudget: createTestTranslatorBudget() };
}

function wrapped(agyEnabled?: boolean): ProviderAdapter {
  const google: ProviderAdapter = {
    name: "google",
    buildRequest: () => ({ url: GOOGLE_URL, method: "POST", headers: {}, body: "{}" }) as AdapterRequest,
    async *parseStream() {},
  };
  const deps: AgyTransportDeps = { accountForToken: () => undefined, bridgeFor: async () => { throw new Error("not used"); } };
  return withAgyTransport(google, provider(agyEnabled), deps);
}

function entry(attempts: Array<Record<string, unknown>>, top: Record<string, unknown> = {}): PersistedUsageEntry {
  return {
    requestId: "ocx-transport-label",
    timestamp: 1,
    provider: "google-antigravity",
    model: "gemini-3.8-flash",
    status: 200,
    durationMs: 5,
    usageStatus: "unreported",
    attempts: attempts.map((attempt, index) => ({
      ordinal: index + 1,
      provider: "google-antigravity",
      model: "gemini-3.8-flash",
      adapter: "google",
      status: 200,
      durationMs: 4,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
      ...attempt,
    }) as never),
    ...top,
  };
}

describe("antigravity usage rows say how the request was sent", () => {
  test.each([
    ["the provider flag is on", true, {}, "agy"],
    ["the provider flag is off", false, {}, "direct"],
    ["the provider has no flag", undefined, {}, "direct"],
    ["the header overrides a disabled flag", false, { "x-opencodex-antigravity-transport": "agy" }, "agy"],
    ["the header overrides an enabled flag", true, { "x-opencodex-antigravity-transport": "direct" }, "direct"],
  ] as const)("the built request is labelled %s", async (_name, flag, headers, expected) => {
    const request = await wrapped(flag).buildRequest(parsed, incoming(headers));
    expect(request.antigravityTransport).toBe(expected);
  });

  test("the label lands on the active attempt, and a rebuilt attempt carries its own", async () => {
    const adapter = wrapped(true);
    const first = beginRequestAttempt(1, "google-antigravity", "gemini-3.8-flash", "google");
    const logCtx = { activeAttempt: first } as unknown as RequestLogContext;
    recordAdapterTransport(logCtx, await adapter.buildRequest(parsed, incoming()));
    expect(first.antigravityTransport).toBe("agy");

    const second = beginRequestAttempt(2, "google-antigravity", "gemini-3.8-flash", "google");
    logCtx.activeAttempt = second;
    recordAdapterTransport(logCtx, await adapter.buildRequest(parsed, incoming({ "x-opencodex-antigravity-transport": "direct" })));
    expect(second.antigravityTransport).toBe("direct");
    expect(first.antigravityTransport).toBe("agy");
  });

  test("an adapter that names no transport leaves the attempt untouched", () => {
    const attempt = beginRequestAttempt(1, "xai", "grok-4.6", "openai-responses");
    recordAdapterTransport({ activeAttempt: attempt } as unknown as RequestLogContext, { url: "https://x", method: "POST", headers: {}, body: "{}" });
    expect("antigravityTransport" in attempt).toBe(false);
  });

  test("the durable row keeps the label per attempt and takes the last attempt's for the request", () => {
    const normalized = normalizeUsageEntryForTest(entry([{ antigravityTransport: "agy" }, { antigravityTransport: "direct" }]));
    expect(normalized.attempts?.map(attempt => attempt.antigravityTransport)).toEqual(["agy", "direct"]);
    expect(normalized.antigravityTransport).toBe("direct");
  });

  test("only the two roster values persist, so nothing else can ride in this field", () => {
    const normalized = normalizeUsageEntryForTest(entry(
      [{ antigravityTransport: "https://example.test/acct?token=secret" }],
      { antigravityTransport: "user@example.test" },
    ));
    expect(normalized.attempts?.[0]).not.toHaveProperty("antigravityTransport");
    expect(normalized).not.toHaveProperty("antigravityTransport");
  });

  test("a row from any other provider keeps its old shape", () => {
    const normalized = normalizeUsageEntryForTest(entry([{}]));
    expect(normalized).not.toHaveProperty("antigravityTransport");
    expect(normalized.attempts?.[0]).not.toHaveProperty("antigravityTransport");
  });
});
