import { describe, expect, it } from "bun:test";
import {
  generatePlaceholder,
  globalPrivacyStats,
  isPrivacyRedactionEnabled,
  PrivacyRedactionError,
  PrivacyStatsStore,
  privacyOptionsFromConfig,
  redactClientBody,
  redactPlainText,
  secretValueId,
} from "../../src/privacy";
import { handlePrivacyRoutes } from "../../src/server/management/privacy-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { anthropicBodyFixture, chatBodyFixture, responsesBodyFixture, THINKING_BLOCK_SECRET } from "./fixtures/bodies";
import {
  fakeBearerToken,
  fakeConnectionString,
  fakeConnectionStringPassword,
  fakeDotEnvSecretLine,
  fakeEmail,
  fakeGoogleApiKey,
  fakeOpenAiKey,
  fakePassword,
  fakePrivateKeyBlock,
} from "./fixtures/secrets";

function ctxFor(req: Request, config: unknown = {}): ManagementContext {
  const url = new URL(req.url);
  return { req, url, config: config as never, deps: {} as never, version: "test", principal: { kind: "admin" } as never } as ManagementContext;
}

describe("redactClientBody: coverage across text positions", () => {
  it("redacts every fake secret in the Responses fixture (instructions, input, function_call.arguments, function_call_output, tools[].description)", () => {
    const apiKey = fakeOpenAiKey("resp-cov");
    const body = responsesBodyFixture("openai-apikey/gpt-5", apiKey);
    const outcome = redactClientBody(body, {});
    const serialized = JSON.stringify(outcome.body);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(fakePassword("r"));
    expect(serialized).not.toContain(fakeBearerToken());
    expect(outcome.hits.length).toBeGreaterThan(0);
  });

  it("redacts every fake secret in the Chat fixture (system, user/tool content, tool_calls[].function.arguments, tool content)", () => {
    const apiKey = fakeOpenAiKey("chat-cov");
    const body = chatBodyFixture("acme/gpt", apiKey);
    const outcome = redactClientBody(body, {});
    const serialized = JSON.stringify(outcome.body);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(fakeConnectionStringPassword());
    expect(serialized).not.toContain(fakeBearerToken());
    // Email is opt-in and off by default.
    expect(serialized).toContain(fakeEmail());
  });

  it("redacts every fake secret in the Anthropic fixture (system, text blocks, tool_use.input, tool_result.content)", () => {
    const apiKey = fakeOpenAiKey("anthropic-cov");
    const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
    const outcome = redactClientBody(body, {});
    const serialized = JSON.stringify(outcome.body);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(fakePassword("a"));
    expect(serialized).not.toContain(fakeBearerToken());
  });
});

describe("redactClientBody: protected fields round-trip byte-for-byte", () => {
  it("preserves a thinking block that carries a non-empty signature, whole -- including the secret text inside it", () => {
    const apiKey = fakeOpenAiKey("thinking-sig");
    const body = anthropicBodyFixture("claude-sonnet-4-6", apiKey);
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    const thinkingBlock = outcome.body.messages[1]!.content[0] as { type: string; thinking: string; signature: string };
    expect(thinkingBlock.type).toBe("thinking");
    expect(thinkingBlock.signature).toBe("fixture-signature-abc123");
    // The secret inside a signed thinking block must NOT be redacted: the whole block is opaque.
    expect(thinkingBlock.thinking).toBe(`secret reasoning about ${THINKING_BLOCK_SECRET}`);
  });

  it("preserves base64 image data byte-for-byte", () => {
    const body = anthropicBodyFixture("claude-sonnet-4-6");
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    const imageBlock = outcome.body.messages[0]!.content[1] as { source: { data: string } };
    expect(imageBlock.source.data).toBe(body.messages[0]!.content[1]!.source.data);
  });

  it("preserves structural fields (id, call_id, tool_use_id, name, model, type, role) untouched", () => {
    const body = anthropicBodyFixture("claude-sonnet-4-6");
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    expect(outcome.body.model).toBe("claude-sonnet-4-6");
    const toolUse = outcome.body.messages[1]!.content[1] as { id: string; name: string; type: string };
    expect(toolUse.id).toBe("call_1");
    expect(toolUse.name).toBe("run_tool");
    expect(toolUse.type).toBe("tool_use");
  });

  it("redacted thinking blocks (redacted_thinking) are preserved whole", () => {
    const body = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-ciphertext-should-not-change" }] }] };
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    expect(outcome.body.messages[0]!.content[0]).toEqual(body.messages[0]!.content[0]);
  });
});

describe("redactClientBody: valid JSON out, including nested function_call.arguments", () => {
  it("the redacted body is itself valid JSON", () => {
    const body = responsesBodyFixture("openai-apikey/gpt-5");
    const outcome = redactClientBody(body, {});
    expect(() => JSON.stringify(outcome.body)).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(outcome.body))).not.toThrow();
  });

  it("function_call.arguments stays valid JSON after redaction, with its secret replaced", () => {
    const body = responsesBodyFixture("openai-apikey/gpt-5");
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    const call = outcome.body.input[1] as { arguments: string };
    const parsedArgs = JSON.parse(call.arguments) as { password: string };
    expect(parsedArgs.password).toMatch(/^\{\{SECRET_[0-9a-f]{8}\}\}$/);
  });

  it("tool_calls[].function.arguments (Chat) stays valid JSON after redaction", () => {
    const body = chatBodyFixture("acme/gpt");
    const outcome = redactClientBody(body, {}) as { body: typeof body };
    const call = outcome.body.messages[2]!.tool_calls![0]!.function;
    const parsed = JSON.parse(call.arguments) as { apiKey: string };
    expect(parsed.apiKey).toMatch(/^\{\{SECRET_[0-9a-f]{8}\}\}$/);
  });
});

describe("redactClientBody: placeholder determinism and allowValues", () => {
  it("the same secret value produces the same placeholder across two separate calls", () => {
    const apiKey = fakeOpenAiKey("determinism");
    const first = redactClientBody({ a: apiKey }, {}) as { body: { a: string } };
    const second = redactClientBody({ a: apiKey }, {}) as { body: { a: string } };
    expect(first.body.a).toBe(second.body.a);
    expect(first.body.a).toBe(generatePlaceholder(apiKey));
  });

  it("allowValues leaves the exact listed value untouched", () => {
    const apiKey = fakeOpenAiKey("allowlisted");
    const outcome = redactClientBody({ a: apiKey }, { allowValues: [apiKey] }) as { body: { a: string } };
    expect(outcome.body.a).toBe(apiKey);
    expect(outcome.hits).toEqual([]);
  });

  it("email is redacted only when redactEmails is on", () => {
    const email = fakeEmail();
    const off = redactPlainText(`contact ${email}`, { redactEmails: false });
    expect(off.body).toContain(email);
    const on = redactPlainText(`contact ${email}`, { redactEmails: true });
    expect(on.body).not.toContain(email);
    expect(on.hits.some((h) => h.kind === "email")).toBe(true);
  });
});

describe("redactClientBody: additional rule coverage (private key, connection string, Google key, .env line)", () => {
  it("redacts a PEM private key block as one unit", () => {
    const block = fakePrivateKeyBlock();
    const outcome = redactPlainText(`key material:\n${block}\nend`);
    expect(outcome.body).not.toContain(block);
    expect(outcome.hits.find((h) => h.kind === "private_key")?.count).toBe(1);
  });

  it("redacts only the password segment of a connection string", () => {
    const conn = fakeConnectionString();
    const outcome = redactPlainText(`DB: ${conn}`);
    expect(outcome.body).not.toContain(fakeConnectionStringPassword());
    expect(outcome.body).toContain("postgres://admin:{{SECRET_");
    expect(outcome.body).toContain("@db.internal:5432/main");
  });

  it("redacts a Google API key", () => {
    const key = fakeGoogleApiKey();
    const outcome = redactPlainText(`GOOGLE_API_KEY=${key}`);
    expect(outcome.body).not.toContain(key);
  });

  it("redacts a .env-style SECRET= line", () => {
    const line = fakeDotEnvSecretLine();
    const outcome = redactPlainText(line);
    expect(outcome.body).not.toBe(line);
    expect(outcome.hits.length).toBeGreaterThan(0);
  });
});

describe("fail-closed: a redaction failure is a hard error, never a silent pass-through", () => {
  it("redactClientBody throws PrivacyRedactionError when options are malformed", () => {
    expect(() => redactClientBody({ a: "x" }, { allowValues: {} as never })).toThrow(PrivacyRedactionError);
  });
});

describe("isPrivacyRedactionEnabled / privacyOptionsFromConfig", () => {
  it("defaults to disabled", () => {
    expect(isPrivacyRedactionEnabled(undefined)).toBe(false);
    expect(isPrivacyRedactionEnabled({} as never)).toBe(false);
  });
  it("turns on via config.privacy.enabled", () => {
    expect(isPrivacyRedactionEnabled({ privacy: { enabled: true } } as never)).toBe(true);
  });
  it("turns on via OPENCODEX_PRIVACY_REDACTION env var", () => {
    const prev = process.env.OPENCODEX_PRIVACY_REDACTION;
    try {
      process.env.OPENCODEX_PRIVACY_REDACTION = "1";
      expect(isPrivacyRedactionEnabled({} as never)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_PRIVACY_REDACTION;
      else process.env.OPENCODEX_PRIVACY_REDACTION = prev;
    }
  });
  it("projects allowValues and maskEmails from config", () => {
    const opts = privacyOptionsFromConfig({ privacy: { allowValues: ["x"], maskEmails: true } } as never);
    expect(opts.allowValues).toEqual(["x"]);
    expect(opts.redactEmails).toBe(true);
  });
});

describe("PrivacyStatsStore", () => {
  it("never records a request with zero hits, and never carries the original value or any prefix of it", () => {
    const store = new PrivacyStatsStore({ capacity: 10 });
    store.record({ ts: Date.now(), client: "codex", provider: "openai", model: "gpt-5", hits: [], placeholderHashes: [] });
    store.record({ ts: Date.now(), client: "codex", provider: "openai", model: "gpt-5", hits: [{ kind: "api_key", count: 2 }], placeholderHashes: ["aabbccdd"] });
    const summary = store.summary("7d", true);
    expect(summary.totals.requests).toBe(1);
    expect(summary.totals.masked).toBe(2);
    expect(summary.totals.distinctValues).toBe(1);
    const dump = JSON.stringify(summary);
    expect(dump).not.toContain(fakeOpenAiKey("stats"));
  });

  it("buckets by day and by (client, provider) flow", () => {
    const store = new PrivacyStatsStore({ capacity: 10 });
    store.record({ ts: Date.now(), client: "codex", provider: "openai", model: "gpt-5", hits: [{ kind: "token", count: 1 }], placeholderHashes: ["11111111"] });
    store.record({ ts: Date.now(), client: "claude-code", provider: "anthropic", model: "claude", hits: [{ kind: "password", count: 3 }], placeholderHashes: ["22222222"] });
    const summary = store.summary("7d", true);
    expect(summary.flows).toContainEqual({ client: "codex", provider: "openai", masked: 1 });
    expect(summary.flows).toContainEqual({ client: "claude-code", provider: "anthropic", masked: 3 });
    const today = summary.daily.at(-1)!;
    expect(today.masked).toBe(4);
  });

  it("record returns an id that backfillRoute can later use to fill in provider/model", () => {
    const store = new PrivacyStatsStore({ capacity: 10 });
    const id = store.record({ ts: Date.now(), client: "codex", hits: [{ kind: "api_key", count: 1 }], placeholderHashes: ["33333333"] });
    expect(id).not.toBeNull();
    let summary = store.summary("7d", true);
    expect(summary.requests[0]!.provider).toBe("unknown");
    store.backfillRoute(id, { provider: "openai", model: "gpt-5" });
    summary = store.summary("7d", true);
    expect(summary.requests[0]!.provider).toBe("openai");
    expect(summary.requests[0]!.model).toBe("gpt-5");
  });

  it("backfillRoute is a silent no-op for a missing or stale id", () => {
    const store = new PrivacyStatsStore({ capacity: 10 });
    expect(() => store.backfillRoute(null, { provider: "x" })).not.toThrow();
    expect(() => store.backfillRoute("not-a-real-id", { provider: "x" })).not.toThrow();
    expect(store.summary("7d", true).totals.requests).toBe(0);
  });

  it("record with zero hits returns null, never a stray id", () => {
    const store = new PrivacyStatsStore({ capacity: 10 });
    expect(store.record({ ts: Date.now(), hits: [], placeholderHashes: [] })).toBeNull();
  });
});

describe("management routes: GET/PUT /api/privacy/config, allow-values, POST /api/privacy/test, GET /api/privacy/stats", () => {
  it("GET /api/privacy/config reflects enabled and projects allowValues as {id, length} only -- never the original value", async () => {
    const kept = fakeOpenAiKey("kept-allowvalue");
    const config = { privacy: { enabled: true, allowValues: [kept] } } as never;
    const req = new Request("http://localhost/api/privacy/config", { method: "GET" });
    const resp = await handlePrivacyRoutes(ctxFor(req, config));
    expect(resp?.status).toBe(200);
    const data = await resp?.json();
    expect(data.enabled).toBe(true);
    expect(data.allowValues).toEqual([{ id: secretValueId(kept), length: kept.length }]);
    expect(JSON.stringify(data)).not.toContain(kept);
  });

  it("PUT /api/privacy/config accepts only { enabled } and never touches allowValues", async () => {
    const kept = fakeOpenAiKey("put-untouched");
    const config = { privacy: { enabled: false, allowValues: [kept] } } as never;
    const putReq = new Request("http://localhost/api/privacy/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const putResp = await handlePrivacyRoutes(ctxFor(putReq, config));
    expect(putResp?.status).toBe(200);
    const data = await putResp?.json();
    expect(data).toEqual({ enabled: true, allowValues: [{ id: secretValueId(kept), length: kept.length }] });
    expect((config as { privacy: { allowValues: string[] } }).privacy.allowValues).toEqual([kept]);
  });

  it("PUT /api/privacy/config rejects a body that still tries to send allowValues or omits enabled", async () => {
    const config = { privacy: {} } as never;
    const missingEnabled = new Request("http://localhost/api/privacy/config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowValues: ["x"] }),
    });
    expect((await handlePrivacyRoutes(ctxFor(missingEnabled, config)))?.status).toBe(400);
  });

  it("POST /api/privacy/allow-values adds a value idempotently and never echoes it back", async () => {
    const config = { privacy: { enabled: true, allowValues: [] as string[] } } as never;
    const value = fakeOpenAiKey("allow-added");
    const add = (): Request => new Request("http://localhost/api/privacy/allow-values", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    const first = await handlePrivacyRoutes(ctxFor(add(), config));
    expect(first?.status).toBe(200);
    const firstData = await first?.json();
    expect(firstData.allowValues).toEqual([{ id: secretValueId(value), length: value.length }]);
    expect(JSON.stringify(firstData)).not.toContain(value);
    // Idempotent: adding the same value again does not duplicate it.
    const second = await handlePrivacyRoutes(ctxFor(add(), config));
    const secondData = await second?.json();
    expect(secondData.allowValues).toHaveLength(1);
    expect((config as { privacy: { allowValues: string[] } }).privacy.allowValues).toEqual([value]);
  });

  it("POST /api/privacy/allow-values rejects an empty or oversized value", async () => {
    const config = { privacy: { enabled: true, allowValues: [] as string[] } } as never;
    const empty = new Request("http://localhost/api/privacy/allow-values", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "" }),
    });
    expect((await handlePrivacyRoutes(ctxFor(empty, config)))?.status).toBe(400);
    const oversized = new Request("http://localhost/api/privacy/allow-values", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(4097) }),
    });
    expect((await handlePrivacyRoutes(ctxFor(oversized, config)))?.status).toBe(400);
  });

  it("DELETE /api/privacy/allow-values/:id removes the matching value by id, 404s for an unknown id", async () => {
    const value = fakeOpenAiKey("allow-deleted");
    const config = { privacy: { enabled: true, allowValues: [value] } } as never;
    const id = secretValueId(value);
    const notFound = await handlePrivacyRoutes(ctxFor(new Request(`http://localhost/api/privacy/allow-values/${id}00`, { method: "DELETE" }), config));
    expect(notFound?.status).toBe(404);
    const deleted = await handlePrivacyRoutes(ctxFor(new Request(`http://localhost/api/privacy/allow-values/${id}`, { method: "DELETE" }), config));
    expect(deleted?.status).toBe(200);
    const data = await deleted?.json();
    expect(data.allowValues).toEqual([]);
    expect((config as { privacy: { allowValues: string[] } }).privacy.allowValues).toEqual([]);
    // Deleted means no longer allowlisted: the value is masked again by the redactor.
    const outcome = redactPlainText(`secret ${value}`, privacyOptionsFromConfig(config as never));
    expect(outcome.body).not.toContain(value);
  });

  it("POST /api/privacy/test returns masked text and hit kinds, and records no stats", async () => {
    const config = {} as never;
    globalPrivacyStats.reset();
    const apiKey = fakeOpenAiKey("try-it");
    const req = new Request("http://localhost/api/privacy/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `my key is ${apiKey}` }),
    });
    const resp = await handlePrivacyRoutes(ctxFor(req, config));
    expect(resp?.status).toBe(200);
    const data = await resp?.json() as { masked: string; hits: Array<{ kind: string; count: number }> };
    expect(data.masked).not.toContain(apiKey);
    expect(data.hits.some((h) => h.kind === "api_key")).toBe(true);
    expect(globalPrivacyStats.summary("7d", true).totals.requests).toBe(0);
  });

  it("GET /api/privacy/stats?range= never returns an original value", async () => {
    globalPrivacyStats.reset();
    const apiKey = fakeOpenAiKey("stats-route");
    globalPrivacyStats.record({ ts: Date.now(), client: "codex", provider: "openai", model: "gpt-5", hits: [{ kind: "api_key", count: 1 }], placeholderHashes: [generatePlaceholder(apiKey).slice(9, 17)] });
    const req = new Request("http://localhost/api/privacy/stats?range=30d", { method: "GET" });
    const resp = await handlePrivacyRoutes(ctxFor(req, { privacy: { enabled: true } } as never));
    expect(resp?.status).toBe(200);
    const data = await resp?.json();
    expect(JSON.stringify(data)).not.toContain(apiKey);
    expect(data.range).toBe("30d");
    expect(data.totals.masked).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/privacy/stats: requests is capped at the 200 most recent, newest first", async () => {
    globalPrivacyStats.reset();
    for (let i = 0; i < 205; i += 1) {
      globalPrivacyStats.record({ ts: Date.now() + i, client: "codex", provider: "openai", model: "gpt-5", hits: [{ kind: "api_key", count: 1 }], placeholderHashes: [`${i}`.padStart(8, "0")] });
    }
    const req = new Request("http://localhost/api/privacy/stats?range=30d", { method: "GET" });
    const resp = await handlePrivacyRoutes(ctxFor(req, { privacy: { enabled: true } } as never));
    const data = await resp?.json();
    expect(data.requests).toHaveLength(200);
    expect(new Date(data.requests[0]!.ts).getTime()).toBeGreaterThan(new Date(data.requests[1]!.ts).getTime());
  });

  it("GET /api/privacy/stats: daily covers every day in range, oldest to newest, zero-filled", async () => {
    globalPrivacyStats.reset();
    const req = new Request("http://localhost/api/privacy/stats?range=7d", { method: "GET" });
    const resp = await handlePrivacyRoutes(ctxFor(req, { privacy: { enabled: true } } as never));
    const data = await resp?.json();
    expect(data.daily).toHaveLength(7);
    expect(data.daily.every((d: { masked: number }) => d.masked === 0)).toBe(true);
    const dates = data.daily.map((d: { date: string }) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});
