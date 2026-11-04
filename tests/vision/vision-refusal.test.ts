import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { resetVisionDescriptionCache, modelAcceptsImageInput, requiresVisionPreprocessing } from "../../src/vision";
import { forgetVisionRefusal, isImageCapabilityRefusal, rememberVisionRefusal, resetVisionRefusals, visionRefusal } from "../../src/vision/refusals";
import { handleVisionRefusalRoutes } from "../../src/server/management/vision-refusal-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const IMAGE = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square.";
const REFUSAL = "image_url is only supported by certain models.";
setDefaultTimeout(30_000);
let previousHome: string | undefined;
let home = "";
let isolated: IsolatedCodexHome;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<{ stop: (close?: boolean) => unknown }> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolated = installIsolatedCodexHome("ocx-refusal-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-refusal-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  resetVisionRefusals();
  resetVisionDescriptionCache();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  resetVisionRefusals();
  resetVisionDescriptionCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated.restore();
  removeTreeWithRetry(home);
});

function requestBody() {
  return { model: "relay/mystery", stream: false, input: [{ role: "user", content: [
    { type: "input_text", text: "What is in this image?" }, { type: "input_image", image_url: IMAGE },
  ] }] };
}

async function setup(adapter: "openai-chat" | "openai-responses", error = REFUSAL, status = 400,
  options: { disabled?: boolean; alwaysRefuse?: boolean; helperFails?: boolean; noHelper?: boolean; budget?: number; abortHelper?: AbortController } = {}) {
  const bodies: string[] = [];
  let helperHits = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.text();
    bodies.push(body);
    if (body.includes("image_url") || body.includes("input_image") || options.alwaysRefuse) {
      return Response.json({ error: { type: "invalid_request_error", message: error } }, { status });
    }
    if (adapter === "openai-chat") return Response.json({ id: "chat-vision", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "A square." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    return Response.json({ id: "resp_vision", object: "response", status: "completed",
      output: [{ id: "msg_vision", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "A square.", annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
  } });
  servers.push(upstream);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "chatgpt.com") {
      helperHits++;
      options.abortHelper?.abort();
      if (options.helperFails) return Promise.resolve(Response.json({ error: { message: "helper unavailable" } }, { status: 400 }));
      return Promise.resolve(new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } }));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: "relay", openaiProviderTierVersion: 2,
    visionSidecar: { enabled: !options.disabled },
    providers: {
      relay: { adapter, baseUrl: upstream.url.toString().replace(/\/$/, "") + "/v1",
        responsesPath: "/responses", authMode: "key", apiKey: "test-placeholder", allowPrivateNetwork: true,
        modelCapabilities: { mystery: { inputModalities: ["text", "image"] } },
        ...(options.budget ? { transientRetryOn5xx: { attempts: options.budget } } : {}),
      },
      ...(!options.noHelper ? { openai: { adapter: "openai-responses", authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct" } as OcxProviderConfig } : {}),
    },
  };
  const send = async (stream = false, image = true, signal?: AbortSignal, terminal = false) => {
    const body = requestBody();
    if (!image) body.input[0].content.pop();
    return handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-refusal" })}`,
        "chatgpt-account-id": "acct-refusal" }, body: JSON.stringify({ ...body, stream }) }), config, { model: "", provider: "" }, { abortSignal: signal, visionDescribeTerminal: terminal });
  };
  return { config, bodies, send, helperHits: () => helperHits };
}

test.each(["openai-chat", "openai-responses"] as const)("%s learns, retries with a description, reuses it and permits undo", async adapter => {
  const fixture = await setup(adapter);
  const first = await fixture.send();
  expect(first.status).toBe(200);
  await first.text();
  expect(fixture.bodies).toHaveLength(2);
  expect(fixture.bodies[0]).toContain("image");
  expect(fixture.bodies[1]).toContain(CAPTION);
  expect(fixture.bodies[1]).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
  expect(fixture.helperHits()).toBe(1);
  expect(modelAcceptsImageInput(fixture.config, { provider: "relay", id: "mystery" })).toBe(false);
  expect(requiresVisionPreprocessing(fixture.config, fixture.config.providers.relay, "mystery", "relay")).toBe(true);
  const next = await fixture.send(true);
  expect(next.status).toBe(200);
  await next.text();
  expect(fixture.bodies).toHaveLength(3);
  expect(fixture.bodies[2]).toContain(CAPTION);
  expect(fixture.helperHits()).toBe(1);
  const url = new URL("http://localhost/api/models/vision-refusal?provider=relay&modelId=mystery");
  const ctx = { config: fixture.config, url, req: new Request(url) } as ManagementContext;
  expect((await handleVisionRefusalRoutes(ctx)!.json()).refusal.modelId).toBe("mystery");
  expect((await handleVisionRefusalRoutes({ ...ctx, req: new Request(url, { method: "DELETE" }) })!.json()).cleared).toBe(true);
  expect(modelAcceptsImageInput(fixture.config, { provider: "relay", id: "mystery" })).toBe(true);
  const afterUndo = await fixture.send();
  await afterUndo.text();
  expect(fixture.bodies).toHaveLength(5);
  expect(fixture.bodies[3]).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
});

test.each([
  [400, "WorkBuddy: Please start a new conversation, replace the image, and try again."],
  [400, "Invalid image data"], [400, "Image too large"], [400, "Unsupported parameter: temperature"],
  [400, "Cannot process image: invalid image data"], [400, "Image input not supported: unsupported format"],
  [400, "Cannot process images temporarily; try again later"],
  [401, REFUSAL], [403, REFUSAL], [429, REFUSAL],
] as const)("does not learn unrelated refusal %s %s", async (status, message) => {
  const fixture = await setup("openai-chat", message, status);
  const response = await fixture.send();
  await response.text();
  expect(fixture.helperHits()).toBe(0);
  expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeUndefined();
});

test.each([415, 422])("recognizes capability refusal status %s", async status => {
  const fixture = await setup("openai-chat", REFUSAL, status);
  const response = await fixture.send();
  expect(response.status).toBe(200);
  await response.text();
  expect(fixture.bodies).toHaveLength(2);
});

test("a second refusal cannot loop", async () => {
  const fixture = await setup("openai-chat", REFUSAL, 400, { alwaysRefuse: true });
  const response = await fixture.send();
  expect(response.status).toBe(400);
  await response.text();
  expect(fixture.bodies).toHaveLength(2);
  expect(fixture.helperHits()).toBe(1);
});

test.each(["openai-chat", "openai-responses"] as const)("%s respects a one-send budget and still learns", async adapter => {
  const fixture = await setup(adapter, REFUSAL, 400, { budget: 1 });
  const response = await fixture.send();
  expect(response.status).toBe(400);
  await response.text();
  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.helperHits()).toBe(0);
  expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeDefined();
});

test("description failure uses the existing error marker and does not cache a failed caption", async () => {
  const fixture = await setup("openai-chat", REFUSAL, 400, { helperFails: true });
  await (await fixture.send()).text();
  expect(fixture.bodies).toHaveLength(2);
  expect(fixture.bodies[1]).toContain("could not be processed");
  await (await fixture.send()).text();
  expect(fixture.helperHits()).toBe(2);
});

test("cancelling during description never sends the replacement main request", async () => {
  const controller = new AbortController();
  const fixture = await setup("openai-chat", REFUSAL, 400, { abortHelper: controller });
  const response = await fixture.send(false, true, controller.signal);
  await response.text();
  expect(controller.signal.aborted).toBe(true);
  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.helperHits()).toBe(1);
});

test("terminal describe calls cannot recursively learn or retry", async () => {
  const fixture = await setup("openai-chat");
  await (await fixture.send(false, true, undefined, true)).text();
  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.helperHits()).toBe(0);
  expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeUndefined();
});

test.each([false, true])("runTurn pre-output rejection retries once (stream=%s)", async stream => {
  const fixture = await setup("openai-chat");
  const seen: string[] = [];
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
    ...create(...args),
    async runTurn(parsed, _incoming, emit) {
      const body = JSON.stringify(parsed.context.messages);
      seen.push(body);
      if (body.includes('"type":"image"')) emit({ type: "error", status: 400, message: REFUSAL });
      else { emit({ type: "text_delta", text: "A square." }); emit({ type: "done" }); }
    },
  }));
  try {
    const response = await fixture.send(stream);
    expect(await response.text()).toContain("A square.");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(CAPTION);
    expect(fixture.helperHits()).toBe(1);
  } finally { override.mockRestore(); }
});

test("runTurn never replays a refusal after output", async () => {
  const fixture = await setup("openai-chat");
  let sends = 0;
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
    ...create(...args), async runTurn(_parsed, _incoming, emit) {
      sends++;
      emit({ type: "text_delta", text: "Already started." });
      emit({ type: "error", status: 400, message: REFUSAL });
    },
  }));
  try {
    expect(await (await fixture.send(true)).text()).toContain("Already started.");
    expect(sends).toBe(1);
    expect(fixture.helperHits()).toBe(0);
    expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeUndefined();
  } finally { override.mockRestore(); }
});

test.each([{ disabled: true }, { noHelper: true }])("preserves original refusal without a usable helper %j", async options => {
  const fixture = await setup("openai-chat", REFUSAL, 400, options);
  const response = await fixture.send();
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(REFUSAL);
  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.helperHits()).toBe(0);
  expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeDefined();
});

test("text-only requests do not learn from an image error message", async () => {
  const fixture = await setup("openai-chat", REFUSAL, 400, { alwaysRefuse: true });
  await (await fixture.send(false, false)).text();
  expect(visionRefusal("relay", fixture.config.providers.relay, "mystery")).toBeUndefined();
});

test("learned identities are provider, endpoint and model scoped and restart-clearable", () => {
  const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://relay.example/v1" };
  rememberVisionRefusal("a", provider, "m");
  expect(visionRefusal("a", provider, "m")).toBeDefined();
  expect(visionRefusal("b", provider, "m")).toBeUndefined();
  expect(visionRefusal("a", provider, "other")).toBeUndefined();
  expect(visionRefusal("a", { ...provider, baseUrl: "https://other.example" }, "m")).toBeUndefined();
  expect(forgetVisionRefusal("b", provider, "m")).toBe(false);
  resetVisionRefusals();
  expect(visionRefusal("a", provider, "m")).toBeUndefined();
});

test("automatic learning has bounded retention", () => {
  const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://relay.example/v1" };
  for (let i = 0; i < 513; i++) rememberVisionRefusal("a", provider, `model-${i}`);
  expect(visionRefusal("a", provider, "model-0")).toBeUndefined();
  expect(visionRefusal("a", provider, "model-512")).toBeDefined();
});

test("error matching ignores echoed request content", () => {
  expect(isImageCapabilityRefusal(400, JSON.stringify({ error: { message: "Invalid parameter" },
    request: { text: REFUSAL } }))).toBe(false);
});

test.each(["Model only supports text input", 'unknown variant `image_url`, expected `text`',
  "This is not a multimodal model", "不支持图片输入"])("recognizes explicit capability wording: %s", message => {
  expect(isImageCapabilityRefusal(400, JSON.stringify({ error: { message } }))).toBe(true);
});
