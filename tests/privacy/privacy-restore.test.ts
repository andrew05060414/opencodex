/**
 * Two-way mode (privacy.restoreResponses): reply-direction restoration of {{SECRET_xxxxxxxx}}
 * placeholders. Covers the pure helpers, SSE chunk-splitting, the three protocols' reply shapes,
 * tool-argument opt-in, and the default-off / fail-safe behaviour. Secrets are built at runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import {
  applyPrivacyRestore,
  generatePlaceholder,
  partialPlaceholderTail,
  redactClientBody,
  registerPrivacyRestore,
  restoreText,
} from "../../src/privacy";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fakeOpenAiKey } from "./fixtures/secrets";

const SECRET = fakeOpenAiKey("restore");
const PH = generatePlaceholder(SECRET);
const MAP = new Map([[PH, SECRET]]);

function enabled(extra: Record<string, unknown> = {}) {
  return { enabled: true, restoreResponses: true, ...extra };
}

function sse(frames: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) { for (const f of frames) { c.enqueue(enc.encode(f)); await Bun.sleep(1); } c.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

function registered(config: OcxConfig, wire: "responses" | "chat" | "messages", response: Response): Response {
  const key = {};
  registerPrivacyRestore(key, wire, MAP, config);
  return applyPrivacyRestore(key, wire, response);
}

describe("restore helpers", () => {
  test("collectRestoreMap is off by default and keeps no originals", () => {
    const body = { messages: [{ role: "user", content: `key ${SECRET}` }] };
    expect(redactClientBody(body).restoreMap).toBeUndefined();
    const withMap = redactClientBody(body, { collectRestoreMap: true });
    expect(withMap.restoreMap?.get(PH)).toBe(SECRET);
    expect(JSON.stringify(withMap.body)).not.toContain(SECRET);
    // The stats-facing fields never carry the original.
    expect(JSON.stringify({ hits: withMap.hits, h: withMap.placeholderHashes })).not.toContain(SECRET);
  });

  test("restoreText only restores placeholders this request knows", () => {
    const other = generatePlaceholder(fakeOpenAiKey("someone-else"));
    expect(restoreText(`a ${PH} b ${other}`, MAP)).toBe(`a ${SECRET} b ${other}`);
  });

  test("restoreText escapes for JSON-string content on request", () => {
    const tricky = new Map([[PH, 'p"w\\d\n']]);
    expect(restoreText(`x${PH}`, tricky, true)).toBe('xp\\"w\\\\d\\n');
  });

  test("partialPlaceholderTail finds only a possible placeholder prefix", () => {
    expect(partialPlaceholderTail("hello")).toBe(0);
    expect(partialPlaceholderTail("hello {")).toBe(1);
    expect(partialPlaceholderTail("hello {{SECRET_ab")).toBe(11);
    expect(partialPlaceholderTail(PH)).toBe(0);
    expect(partialPlaceholderTail("{{SECRET_zz")).toBe(0);
    expect(partialPlaceholderTail(PH.slice(0, -1))).toBe(PH.length - 1);
  });

  test("a prefix collision between two values is never restored", async () => {
    const a = redactClientBody({ x: `k=${SECRET}` }, { collectRestoreMap: true });
    const reg: object = {};
    const config = { privacy: { enabled: true, restoreResponses: true } } as unknown as OcxConfig;
    registerPrivacyRestore(reg, "chat", a.restoreMap, config);
    registerPrivacyRestore(reg, "chat", new Map([[PH, "a-different-value"]]), config);
    const res = applyPrivacyRestore(reg, "chat", Response.json({ choices: [{ message: { content: PH } }] }));
    expect(JSON.stringify(await res.json())).toContain(PH);
  });
});

describe("streaming restore across protocols", () => {
  const config = { privacy: enabled() } as unknown as OcxConfig;
  const cut = (s: string, parts: number) => {
    const n = Math.ceil(s.length / parts);
    return Array.from({ length: parts }, (_, i) => s.slice(i * n, (i + 1) * n)).filter(Boolean);
  };

  test("Responses: placeholder cut across deltas is restored", async () => {
    const pieces = ["use ", ...cut(PH, 5), " now"];
    const frames = pieces.map((d) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: d })}\n\n`);
    frames.push(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "i", output_index: 0, content_index: 0, text: `use ${PH} now` })}\n\n`);
    const out = await registered(config, "responses", sse(frames)).text();
    const deltas = [...out.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    expect(deltas).toBe(`use ${SECRET} now`);
    expect(out).toContain(`"text":"use ${SECRET} now"`);
    expect(out).not.toContain("{{SECRET_");
  });

  test("Responses: unrelated events are untouched and an unfinished tail is flushed as received", async () => {
    const frames = [
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: "end {{SECR" })}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n`,
    ];
    const out = await registered(config, "responses", sse(frames)).text();
    expect(out.startsWith(frames[0]!)).toBe(true);
    expect(out).toContain("end ");
    expect(out.indexOf("{{SECR")).toBeGreaterThan(-1);
    expect(out.indexOf("{{SECR")).toBeLessThan(out.indexOf("response.completed"));
  });

  test("Chat: delta.content split across chunks, with [DONE]", async () => {
    const chunk = (content: string, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
    const frames = [chunk("k="), ...cut(PH, 4).map((p) => chunk(p)), chunk("!", "stop"), "data: [DONE]\n\n"];
    const out = await registered(config, "chat", sse(frames)).text();
    const text = [...out.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    expect(text).toBe(`k=${SECRET}!`);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("Messages: text_delta split across events; thinking and signature untouched", async () => {
    const d = (i: number, delta: Record<string, unknown>) =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta })}\n\n`;
    const frames = [
      d(0, { type: "thinking_delta", thinking: `think ${PH}` }),
      d(0, { type: "signature_delta", signature: PH }),
      ...cut(PH, 3).map((p) => d(1, { type: "text_delta", text: p })),
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const out = await registered(config, "messages", sse(frames)).text();
    expect([...out.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).join("")).toBe(SECRET);
    expect(out).toContain(`"thinking":"think ${PH}"`);
    expect(out).toContain(`"signature":"${PH}"`);
  });

  test("tool-call argument deltas stay masked unless restoreToolArguments is on", async () => {
    const frame = (p: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } })}\n\n`;
    const parts = ['{"cmd":"curl -H ', ...cut(PH, 3), '"}'];
    const off = await registered(config, "messages", sse(parts.map(frame))).text();
    expect(off).not.toContain(SECRET);
    const onConfig = { privacy: enabled({ restoreToolArguments: true }) } as unknown as OcxConfig;
    const on = await registered(onConfig, "messages", sse(parts.map(frame))).text();
    const json = [...on.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
    expect(JSON.parse(json).cmd).toBe(`curl -H ${SECRET}`);
  });

  test("an upstream stream error surfaces as an error, never as a guess", async () => {
    const enc = new TextEncoder();
    let sent = false;
    const broken = new Response(new ReadableStream({
      async pull(c) {
        if (!sent) { sent = true; c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "{{SEC" } }] })}\n\n`)); return; }
        await Bun.sleep(1);
        c.error(new Error("boom"));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    await expect(registered(config, "chat", broken).text()).rejects.toThrow();
  });
});

describe("non-stream restore", () => {
  const config = { privacy: enabled() } as unknown as OcxConfig;

  test("Responses / Chat / Messages bodies restore assistant text only", async () => {
    const responses = await registered(config, "responses", Response.json({
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: PH }], encrypted_content: PH },
        { type: "message", content: [{ type: "output_text", text: `a ${PH} "q"` }] }],
    })).json() as { output: Array<Record<string, unknown>> };
    expect(JSON.stringify(responses.output[0])).toContain(PH);
    expect((responses.output[1]!.content as Array<{ text: string }>)[0]!.text).toBe(`a ${SECRET} "q"`);

    const chat = await registered(config, "chat", Response.json({ choices: [{ message: { role: "assistant", content: PH } }] })).json() as { choices: Array<{ message: { content: string } }> };
    expect(chat.choices[0]!.message.content).toBe(SECRET);

    const msg = await registered(config, "messages", Response.json({ content: [{ type: "text", text: PH }, { type: "thinking", thinking: PH, signature: "sig" }] })).json() as { content: Array<Record<string, string>> };
    expect(msg.content[0]!.text).toBe(SECRET);
    expect(msg.content[1]!.thinking).toBe(PH);
  });

  test("tool arguments (string and tool_use.input) restore only with restoreToolArguments", async () => {
    const body = () => Response.json({
      choices: [{ message: { content: "x", tool_calls: [{ function: { name: "f", arguments: JSON.stringify({ k: PH }) } }] } }],
      content: [{ type: "tool_use", name: "f", input: { k: PH } }],
    });
    const off = JSON.stringify(await registered(config, "chat", body()).json());
    expect(off).not.toContain(SECRET);
    const onConfig = { privacy: enabled({ restoreToolArguments: true }) } as unknown as OcxConfig;
    const on = await registered(onConfig, "chat", body()).json() as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>; content: Array<{ input: { k: string } }> };
    expect(JSON.parse(on.choices[0]!.message.tool_calls[0]!.function.arguments).k).toBe(SECRET);
    expect(on.content[0]!.input.k).toBe(SECRET);
  });

  test("error responses are not rewritten, and an unregistered request is untouched", async () => {
    const err = registered(config, "chat", Response.json({ error: { message: PH } }, { status: 500 }));
    expect(await err.text()).toContain(PH);
    const plain = Response.json({ x: 1 });
    expect(applyPrivacyRestore({}, "chat", plain)).toBe(plain);
  });

  test("unparseable JSON passes through byte-for-byte", async () => {
    const res = registered(config, "chat", new Response(`not json ${PH}`, { headers: { "content-type": "application/json" } }));
    expect(await res.text()).toBe(`not json ${PH}`);
  });
});

describe("end to end through the real entry points", () => {
  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-privacy-restore-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(() => {
    release?.();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  /** Upstream that finds the placeholder in the request it received and echoes it back. */
  function echoUpstream(shape: (placeholder: string) => Response) {
    const bodies: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const text = await req.text();
        bodies.push(text);
        return shape(/\{\{SECRET_[0-9a-f]{8}\}\}/.exec(text)?.[0] ?? "NO-PLACEHOLDER");
      },
    });
    return { url: server.url.toString().replace(/\/$/, ""), bodies, stop: () => server.stop(true) };
  }

  const chatConfig = (url: string, privacy: Record<string, unknown>) => ({
    port: 0, defaultProvider: "pr", providers: { pr: { adapter: "openai-chat", baseUrl: url, authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true } },
    privacy,
  }) as unknown as OcxConfig;
  const chatReq = (stream: boolean) => new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pr/test", stream, messages: [{ role: "user", content: `my key is ${SECRET}` }] }),
  });
  const chatReply = (p: string) => Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: `you said ${p}` }, finish_reason: "stop" }] });

  test("Chat: upstream sees only the placeholder; client gets the original back", async () => {
    const up = echoUpstream(chatReply);
    try {
      const res = await handleChatCompletions(chatReq(false), chatConfig(up.url, enabled()), { model: "", provider: "" });
      const text = await res.text();
      expect(up.bodies[0]).not.toContain(SECRET);
      expect(text).toContain(`you said ${SECRET}`);
    } finally { up.stop(); }
  });

  test("Chat streaming: cut placeholder restored for the client", async () => {
    const up = echoUpstream((p) => {
      const mk = (c: string, f: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: c }, finish_reason: f }] })}\n\n`;
      return sse([mk("is "), mk(p.slice(0, 7)), mk(p.slice(7)), mk("", "stop"), "data: [DONE]\n\n"]);
    });
    try {
      const res = await handleChatCompletions(chatReq(true), chatConfig(up.url, enabled()), { model: "", provider: "" });
      const text = await res.text();
      expect([...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("")).toContain(`is ${SECRET}`);
    } finally { up.stop(); }
  });

  test("default (restoreResponses off): the reply keeps the placeholder", async () => {
    const up = echoUpstream(chatReply);
    try {
      const res = await handleChatCompletions(chatReq(false), chatConfig(up.url, { enabled: true }), { model: "", provider: "" });
      const text = await res.text();
      expect(text).toContain("{{SECRET_");
      expect(text).not.toContain(SECRET);
    } finally { up.stop(); }
  });

  test("Messages native passthrough: text restored, request stays masked", async () => {
    const up = echoUpstream((p) => Response.json({ type: "message", id: "m", role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: `echo ${p}` }], usage: { input_tokens: 1, output_tokens: 1 } }));
    try {
      const config = { providers: {}, claudeCode: { anthropicBaseUrl: up.url }, privacy: enabled() } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: `key ${SECRET}` }] }),
      });
      const res = await handleClaudeMessages(req, config, { model: "claude-sonnet-4-6", provider: "anthropic-native" });
      const text = await res.text();
      expect(up.bodies[0]).not.toContain(SECRET);
      expect(text).toContain(`echo ${SECRET}`);
    } finally { up.stop(); }
  });

  test("Responses native: output_text restored", async () => {
    const up = echoUpstream((p) => Response.json({
      id: "r", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `got ${p}` }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }));
    try {
      const config = {
        port: 0, defaultProvider: "pr", openaiProviderTierVersion: 2,
        providers: { pr: { adapter: "openai-responses", baseUrl: up.url, authMode: "key", apiKey: "fixture-platform-key", allowPrivateNetwork: true } },
        privacy: enabled(),
      } as unknown as OcxConfig;
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pr/gpt-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `key ${SECRET}` }] }] }),
      });
      const res = await handleResponses(req, config, { model: "", provider: "" });
      const text = await res.text();
      expect(up.bodies[0]).not.toContain(SECRET);
      expect(text).toContain(`got ${SECRET}`);
    } finally { up.stop(); }
  });
});
