import { describe, expect, test } from "bun:test";
import { createRegisteredAdapter } from "../../../src/adapters/registry";
import type { IncomingMeta } from "../../../src/adapters/base";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const AGY_HEADER = { "x-opencodex-antigravity-transport": "agy" };

function cloudCodeProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "fake-token",
    googleMode: "cloud-code-assist",
    agyTransport: { enabled: true },
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "gemini-3.8-flash",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: {},
  } as OcxParsedRequest;
}

function incoming(): IncomingMeta {
  return { headers: new Headers(AGY_HEADER), translatorBudget: createTestTranslatorBudget() };
}

describe("agy transport registration", () => {
  test("google-antigravity with cloud-code-assist gets the agy transport", async () => {
    const adapter = createRegisteredAdapter(cloudCodeProvider(), { providerId: "google-antigravity" });

    const request = await adapter.buildRequest(parsed(), incoming());

    expect(request.url.startsWith("agy://local/")).toBe(true);
  });

  test("another google provider keeps Google's transport even with the agy header", async () => {
    const adapter = createRegisteredAdapter(
      cloudCodeProvider({ googleMode: "ai-studio", baseUrl: "https://generativelanguage.googleapis.com" }),
      { providerId: "google" },
    );

    const request = await adapter.buildRequest(parsed(), incoming());

    expect(request.url.startsWith("https://")).toBe(true);
  });

  test("google-antigravity on the AI Studio mode does not get the agy transport", async () => {
    const adapter = createRegisteredAdapter(
      cloudCodeProvider({ googleMode: "ai-studio", baseUrl: "https://generativelanguage.googleapis.com" }),
      { providerId: "google-antigravity" },
    );

    const request = await adapter.buildRequest(parsed(), incoming());

    expect(request.url.startsWith("https://")).toBe(true);
  });
});
