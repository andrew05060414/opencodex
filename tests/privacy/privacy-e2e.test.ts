/**
 * End-to-end acceptance for privacy_contract.md's core claim: a fake upstream never receives
 * a secret from the client's original request body, across all three protocol entry points --
 * including BOTH native-passthrough branches that used to bypass redaction entirely
 * (privacy_brief_backend.md known issue #2).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import { globalPrivacyStats } from "../../src/privacy";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { anthropicBodyFixture, chatBodyFixture, responsesBodyFixture, THINKING_BLOCK_SECRET } from "./fixtures/bodies";
import { fakeOpenAiKey } from "./fixtures/secrets";

let home: string;
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-privacy-e2e-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

interface FakeUpstream { url: string; bodies: unknown[]; stop: () => void }

function fakeUpstream(reply: () => Response = () => Response.json({ ok: true })): FakeUpstream {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const text = await req.text();
      bodies.push(text.length ? JSON.parse(text) : null);
      return reply();
    },
  });
  return { url: server.url.toString().replace(/\/$/, ""), bodies, stop: () => server.stop(true) };
}

describe("Responses (/v1/responses): mounted on the client body before any routing", () => {
  test("enabled: the fake upstream never sees the fake secret", async () => {
    const upstream = fakeUpstream(() => Response.json({
      id: "resp_1", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }));
    try {
      const apiKey = fakeOpenAiKey("responses-e2e");
      const config = {
        port: 0, defaultProvider: "privacy-e2e-responses", openaiProviderTierVersion: 2,
        providers: { "privacy-e2e-responses": { adapter: "openai-responses", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-platform-key", allowPrivateNetwork: true } },
        privacy: { enabled: true },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(responsesBodyFixture("privacy-e2e-responses/gpt-5", apiKey)),
      });
      const response = await handleResponses(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.bodies).toHaveLength(1);
      expect(JSON.stringify(upstream.bodies[0])).not.toContain(apiKey);
    } finally { upstream.stop(); }
  });

  test("disabled (default): the request body reaches upstream byte-for-byte, including the secret", async () => {
    const upstream = fakeUpstream(() => Response.json({
      id: "resp_2", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }));
    try {
      const apiKey = fakeOpenAiKey("responses-disabled");
      const config = {
        port: 0, defaultProvider: "privacy-e2e-responses", openaiProviderTierVersion: 2,
        providers: { "privacy-e2e-responses": { adapter: "openai-responses", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-platform-key", allowPrivateNetwork: true } },
      } as unknown as OcxConfig;
      const sentBody = responsesBodyFixture("privacy-e2e-responses/gpt-5", apiKey);
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      const response = await handleResponses(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.bodies).toHaveLength(1);
      expect((upstream.bodies[0] as { instructions: string }).instructions).toBe(sentBody.instructions);
      expect(JSON.stringify(upstream.bodies[0])).toContain(apiKey);
    } finally { upstream.stop(); }
  });

  test("fail closed: a redaction error returns 503 and the fake upstream is never called", async () => {
    const upstream = fakeUpstream();
    try {
      const config = {
        port: 0, defaultProvider: "privacy-e2e-responses", openaiProviderTierVersion: 2,
        providers: { "privacy-e2e-responses": { adapter: "openai-responses", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-platform-key", allowPrivateNetwork: true } },
        // Malformed on purpose: allowValues must be string[]; this simulates an unexpected
        // runtime failure inside the redactor rather than a validation-rejected config.
        privacy: { enabled: true, allowValues: {} },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(responsesBodyFixture("privacy-e2e-responses/gpt-5")),
      });
      const response = await handleResponses(req, config, { model: "", provider: "" });
      expect(response.status).toBe(503);
      expect(upstream.bodies).toHaveLength(0);
    } finally { upstream.stop(); }
  });
});

describe("Chat Completions (/v1/chat/completions) native passthrough: known issue #2", () => {
  test("enabled: the native lane's fake upstream never sees the fake secret", async () => {
    const upstream = fakeUpstream(() => Response.json({
      id: "chatcmpl_1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
    try {
      const NAME = "native-chat-privacy";
      const apiKey = fakeOpenAiKey("chat-native-e2e");
      const config = {
        port: 0, defaultProvider: NAME,
        providers: { [NAME]: { adapter: "openai-chat", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true } },
        privacy: { enabled: true },
      } as unknown as OcxConfig;
      const body = chatBodyFixture(`${NAME}/test`, apiKey);
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = await handleChatCompletions(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.bodies).toHaveLength(1);
      // Confirms the NATIVE lane was actually taken (it forwards verbatim to /chat/completions,
      // unlike the Responses-bridge lane, which would translate the shape entirely).
      expect(upstream.bodies[0]).toHaveProperty("messages");
      expect(JSON.stringify(upstream.bodies[0])).not.toContain(apiKey);
    } finally { upstream.stop(); }
  });

  test("fail closed: a redaction error returns 503 and the native upstream is never called", async () => {
    const upstream = fakeUpstream();
    try {
      const NAME = "native-chat-privacy-failclosed";
      const config = {
        port: 0, defaultProvider: NAME,
        providers: { [NAME]: { adapter: "openai-chat", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true } },
        privacy: { enabled: true, allowValues: {} },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBodyFixture(`${NAME}/test`)),
      });
      const response = await handleChatCompletions(req, config, { model: "", provider: "" });
      expect(response.status).toBe(503);
      expect(upstream.bodies).toHaveLength(0);
    } finally { upstream.stop(); }
  });
});

describe("Anthropic Messages (/v1/messages) native passthrough: known issue #2", () => {
  test("enabled: the native lane's fake upstream never sees the fake secret, and preserves signed thinking + base64 verbatim", async () => {
    const upstream = fakeUpstream(() => new Response('{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}', { headers: { "content-type": "application/json" } }));
    try {
      const apiKey = fakeOpenAiKey("claude-native-e2e");
      const config = {
        providers: {},
        claudeCode: { anthropicBaseUrl: upstream.url },
        privacy: { enabled: true },
      } as unknown as OcxConfig;
      const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
      const req = new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify(body),
      });
      const response = await handleClaudeMessages(req, config, { model: "claude-sonnet-4-6", provider: "anthropic-native" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.bodies).toHaveLength(1);
      const sent = upstream.bodies[0] as typeof body;
      expect(JSON.stringify(sent)).not.toContain(apiKey);
      // Signed thinking block preserved whole, secret text and all.
      const thinkingBlock = sent.messages[1]!.content[0] as { signature: string; thinking: string };
      expect(thinkingBlock.signature).toBe("fixture-signature-abc123");
      expect(thinkingBlock.thinking).toBe(`secret reasoning about ${THINKING_BLOCK_SECRET}`);
      // base64 image preserved byte-for-byte.
      const imageBlock = sent.messages[0]!.content[1] as { source: { data: string } };
      expect(imageBlock.source.data).toBe(body.messages[0]!.content[1]!.source.data);
    } finally { upstream.stop(); }
  });

  test("fail closed: a redaction error returns 503 and the native upstream is never called", async () => {
    const upstream = fakeUpstream();
    try {
      const config = {
        providers: {},
        claudeCode: { anthropicBaseUrl: upstream.url },
        privacy: { enabled: true, allowValues: {} },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify(anthropicBodyFixture("claude-sonnet-4-6")),
      });
      const response = await handleClaudeMessages(req, config, { model: "claude-sonnet-4-6", provider: "anthropic-native" });
      expect(response.status).toBe(503);
      expect(upstream.bodies).toHaveLength(0);
    } finally { upstream.stop(); }
  });
});

describe("Anthropic Messages count_tokens (/v1/messages/count_tokens) native passthrough", () => {
  test("enabled: the fake upstream never sees the fake secret", async () => {
    const upstream = fakeUpstream(() => Response.json({ input_tokens: 42 }));
    try {
      const apiKey = fakeOpenAiKey("count-tokens-e2e");
      const config = {
        providers: {},
        claudeCode: { anthropicBaseUrl: upstream.url },
        privacy: { enabled: true },
      } as unknown as OcxConfig;
      const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
      const req = new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify(body),
      });
      const response = await handleClaudeCountTokens(req, config);
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.bodies).toHaveLength(1);
      expect(JSON.stringify(upstream.bodies[0])).not.toContain(apiKey);
    } finally { upstream.stop(); }
  });

  test("fail closed: a redaction error returns 503 and the fake upstream is never called", async () => {
    const upstream = fakeUpstream();
    try {
      const config = {
        providers: {},
        claudeCode: { anthropicBaseUrl: upstream.url },
        privacy: { enabled: true, allowValues: {} },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify(anthropicBodyFixture("claude-sonnet-4-6")),
      });
      const response = await handleClaudeCountTokens(req, config);
      expect(response.status).toBe(503);
      expect(upstream.bodies).toHaveLength(0);
    } finally { upstream.stop(); }
  });
});

describe("privacy stats: provider/model are backfilled once routing settles (Chat Completions)", () => {
  test("GET /api/privacy/stats shows the real provider and model, not \"unknown\"", async () => {
    globalPrivacyStats.reset();
    const upstream = fakeUpstream(() => Response.json({
      id: "chatcmpl_backfill", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
    try {
      const NAME = "native-chat-privacy-backfill";
      const apiKey = fakeOpenAiKey("chat-backfill-e2e");
      const config = {
        port: 0, defaultProvider: NAME,
        providers: { [NAME]: { adapter: "openai-chat", baseUrl: upstream.url, authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true } },
        privacy: { enabled: true },
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBodyFixture(`${NAME}/test`, apiKey)),
      });
      const response = await handleChatCompletions(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      const { handlePrivacyRoutes } = await import("../../src/server/management/privacy-routes");
      const statsReq = new Request("http://localhost/api/privacy/stats?range=30d", { method: "GET" });
      const statsResp = await handlePrivacyRoutes({
        req: statsReq, url: new URL(statsReq.url), config, deps: {}, version: "test", principal: { kind: "admin" },
      } as never);
      const data = await statsResp?.json();
      expect(data.requests.length).toBeGreaterThan(0);
      const row = data.requests[0]!;
      expect(row.provider).toBe(NAME);
      expect(row.model).toBe("test");
      expect(row.provider).not.toBe("unknown");
    } finally { upstream.stop(); }
  });
});
