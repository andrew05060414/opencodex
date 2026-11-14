import { expect, spyOn, test } from "bun:test";
import * as retry from "../../src/lib/upstream-retry";
import { antigravityModelNotFoundStrength, isAntigravityModelNotFoundRefusal } from "../../src/server/responses/antigravity-validation-refusal";
import { fetchAntigravityWithRetry } from "../../src/adapters/google-http";
import { antigravityRateLimit } from "../../src/adapters/antigravity-refusal";
import { antigravityPoolBreakerSeconds, planAntigravity429Rotation, resetAntigravityRateLimitPolicy, withDeclinedCause } from "../../src/oauth/antigravity-rate-limit-policy";

const model = "gemini-3.8-flash";
async function normalized(body: string | ReadableStream<Uint8Array>, status = 404): Promise<Response> {
  return fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, {
    executor: (async () => new Response(body, { status })) as typeof fetch,
  });
}
const envelope = (message = "Requested entity was not found.", resourceName = `models/${model}`) => JSON.stringify({
  error: { code: 404, status: "NOT_FOUND", message, details: [{ "@type": "type.googleapis.com/google.rpc.ResourceInfo", resourceName }] },
});

test("CCA model 404 classification requires original model-specific evidence", async () => {
  const text = "Requested entity was not found.";
  const accepted = await normalized(envelope());
  expect(await isAntigravityModelNotFoundRefusal(accepted)).toBe(true);
  expect(await accepted.text()).toContain(text);
  for (const status of [400, 401, 403, 404, 429, 500])
    expect(await isAntigravityModelNotFoundRefusal(new Response(text, { status }))).toBe(false);
  for (const body of ["not found", "Requested entity is missing", "x".repeat(4097) + text, text + "x".repeat(4097)])
    expect(await isAntigravityModelNotFoundRefusal(await normalized(body))).toBe(false);
  expect(await isAntigravityModelNotFoundRefusal(await normalized(envelope()), AbortSignal.abort())).toBe(false);
});

test("ambiguous and mismatched original resource errors cannot authorize model denial", async () => {
  for (const body of [
    envelope("Requested entity was not found.", "projects/synthetic-project"),
    envelope("Requested entity was not found.", "models/other-model"),
    envelope("Requested entity was not found.", `projects/synthetic-project/models/${model}`),
    envelope(`Model '${model}' was not found.`, "projects/synthetic-project")])
    expect(await isAntigravityModelNotFoundRefusal(await normalized(body))).toBe(false);
});

test("Google's bare CCA model 404 is bare evidence: it may rotate but is not strong evidence", async () => {
  const bare = JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } });
  const response = await normalized(bare);
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(true);
  expect(antigravityModelNotFoundStrength(response)).toBe("bare");
  expect(antigravityModelNotFoundStrength(await normalized(envelope()))).toBe("strong");
  expect(antigravityModelNotFoundStrength(response, AbortSignal.abort())).toBeUndefined();
  for (const message of ["Requested entity was not found. Also something else", "Not found", "entity missing"])
    expect(antigravityModelNotFoundStrength(await normalized(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message } })))).toBeUndefined();
});

test("incidental model mentions without ResourceInfo cannot authorize model denial", async () => {
  for (const message of [
    `Project projects/p was not found while resolving models/${model}`,
    `Model 'other-model' was not found while resolving models/${model}`,
    `models/other-model not found; requested models/${model}`,
    `Model '${model}' was not found.`,
  ]) {
    const response = await normalized(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message } }));
    expect(response.status).toBe(404);
    expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  }
});

test("a 5 KiB original JSON model 404 cannot become trusted after Google normalization", async () => {
  const payload = JSON.parse(envelope());
  payload.error.filler = "x".repeat(5000);
  const result = await normalized(JSON.stringify(payload));
  expect(await isAntigravityModelNotFoundRefusal(result)).toBe(false);
  expect(await result.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("the original refusal ceiling counts UTF-8 bytes and admits exactly 4096", async () => {
  const payload = JSON.parse(envelope());
  payload.error.filler = "";
  payload.error.filler = "x".repeat(4096 - Buffer.byteLength(JSON.stringify(payload), "utf8"));
  expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(4096);
  expect(await isAntigravityModelNotFoundRefusal(await normalized(JSON.stringify(payload)))).toBe(true);
  payload.error.filler += "é";
  expect(await isAntigravityModelNotFoundRefusal(await normalized(JSON.stringify(payload)))).toBe(false);
});

test("an incomplete original model 404 stream cannot authorize rotation", async () => {
  const response = await normalized(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(envelope())); },
    cancel() {},
  }));
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  expect(await response.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("an erroring original 404 body preserves status without denial provenance", async () => {
  const response = await normalized(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(envelope())); },
    pull(controller) { controller.error(new TypeError("synthetic body reset")); },
  }));
  expect(response.status).toBe(404);
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  expect(await response.text()).toBe("Antigravity invalid request: HTTP 404");
});

test("cancellation while reading an original 404 body propagates by identity", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  let reading!: () => void;
  const atRead = new Promise<void>(resolve => { reading = resolve; });
  const pending = fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, {
    abortSignal: controller.signal,
    executor: (async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading(); },
    }, { highWaterMark: 0 }), { status: 404 })) as typeof fetch,
  });
  await atRead;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

const rateLimitBody = (reason: string | undefined, metadata: object, retryDelay?: string) => JSON.stringify({ error: { code: 429,
  status: "RESOURCE_EXHAUSTED", message: "synthetic", details: [
    ...(reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata }] : []),
    ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
  ] } });

test("every Antigravity 429 carries its parsed reason and Retry-After, not only quota exhaustion", async () => {
  const sleep = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
  try { await rateLimitAssertions(); } finally { sleep.mockRestore(); }
});

async function rateLimitAssertions(): Promise<void> {
  const send = async (body: string) => fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, { executor: (async () => new Response(body, { status: 429 })) as typeof fetch });
  const quota = await send(rateLimitBody("QUOTA_EXHAUSTED", { quotaResetDelay: "1h16m0.5s" }));
  expect(antigravityRateLimit(quota)).toMatchObject({ kind: "quota", reasoned: true, waitSeconds: 4561 });
  expect(quota.headers.get("retry-after")).toBe("4561");
  const capacity = await send(rateLimitBody("MODEL_CAPACITY_EXHAUSTED", {}, "2s"));
  expect(antigravityRateLimit(capacity)).toMatchObject({ kind: "capacity", reasoned: true, retryDelaySeconds: 2 });
  expect(capacity.headers.get("retry-after")).toBe("2");
  const plain = await send(rateLimitBody(undefined, {}));
  expect(antigravityRateLimit(plain)).toMatchObject({ kind: "declined", reasoned: false });
  expect(plain.headers.has("retry-after")).toBe(false);
  const retryOnly = await send(rateLimitBody(undefined, {}, "3s"));
  expect(antigravityRateLimit(retryOnly)).toMatchObject({ kind: "unreasoned", reasoned: false, retryDelaySeconds: 3 });
  const rate = await send(rateLimitBody("RATE_LIMIT_EXCEEDED", {}, "7s"));
  expect(antigravityRateLimit(rate)).toMatchObject({ kind: "unreasoned", reasoned: true, retryDelaySeconds: 7 });
  expect(rate.headers.get("retry-after")).toBe("7");
}

test("the pool breaker opens after three accounts answer reasonless 429s for one model inside a minute", async () => {
  resetAntigravityRateLimitPolicy();
  const request = {};
  const now = Date.now();
  for (const account of ["a", "b"]) planAntigravity429Rotation({}, undefined, account, "m", undefined, now);
  expect(antigravityPoolBreakerSeconds("m", now)).toBe(0);
  planAntigravity429Rotation({}, undefined, "c", "m", undefined, now);
  expect(antigravityPoolBreakerSeconds("m", now)).toBeGreaterThanOrEqual(30);
  expect(antigravityPoolBreakerSeconds("m", now)).toBeLessThanOrEqual(60);
  expect(antigravityPoolBreakerSeconds("other-model", now)).toBe(0);
  expect(antigravityPoolBreakerSeconds("m", now + 61_000)).toBe(0);
  const declined = await fetchAntigravityWithRetry({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    method: "POST", headers: {}, body: JSON.stringify({ model }) }, { executor: (async () => new Response(rateLimitBody(undefined, {}), { status: 429 })) as typeof fetch });
  const hint: { causeHint?: string } = {};
  expect(withDeclinedCause(planAntigravity429Rotation({}, declined, "x", "m3", undefined, now), hint)).toEqual({ rotate: false, declined: true });
  expect(hint.causeHint).toBe("payload-rejected");
  expect(antigravityPoolBreakerSeconds("m3", now)).toBe(0);
  expect(planAntigravity429Rotation(request, undefined, "d", "m2", undefined, now).rotate).toBe(true);
  expect(planAntigravity429Rotation(request, undefined, "e", "m2", undefined, now).rotate).toBe(false);
  resetAntigravityRateLimitPolicy();
});
