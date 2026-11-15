import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgyBridge, type AgyBridge } from "../../../src/adapters/agy-acp/vendor/index.mjs";
import { fixturePath } from "../../helpers/repo-root";
import { withAgyTransport } from "../../../src/adapters/agy-acp/adapter";
import type { ProviderAdapter } from "../../../src/adapters/base";
import { parseRequest } from "../../../src/responses/parser";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

interface FakeEvent { pid: number; event: string; sessionId?: string }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A bridge over the fake agy, with its own home, state file and event log. */
function fakeBridge(): { bridge: AgyBridge; events: () => FakeEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), "ocx-agy-spare-"));
  const script = fixturePath("agy-acp", "fake-agy.mjs");
  let agyPath: string;
  if (process.platform === "win32") {
    agyPath = join(dir, "agy.cmd");
    writeFileSync(agyPath, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    agyPath = join(dir, "agy");
    writeFileSync(agyPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(agyPath, 0o755);
  }
  const log = join(dir, "events.jsonl");
  const bridge = createAgyBridge({
    env: { FAKE_AGY_LOG: log, HOME: dir, USERPROFILE: dir },
    home: dir,
    stateFile: join(dir, "bridge-state.json"),
    agyPath,
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => bridge.shutdown());
  const events = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as FakeEvent)
    : [];
  return { bridge, events };
}

async function ask(bridge: AgyBridge, text: string): Promise<string> {
  const response = await bridge.fetch("agy://local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", max_tokens: 64, stream: false, messages: [{ role: "user", content: text }] }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { content: Array<{ type: string; text?: string }> };
  return body.content.filter(block => block.type === "text").map(block => block.text).join("");
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const starts = (events: FakeEvent[]) => events.filter(event => event.event === "start");
const prompted = (events: FakeEvent[]) => events.filter(event => event.event === "session/prompt");

describe("agy warm spare process", () => {
  test("identical Responses openings in concurrent Codex threads have different conversation keys and retain their session on the next turn", async () => {
    const { bridge, events } = fakeBridge();
    const rows: Array<{ action?: string; conv?: string }> = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const capture = spyOn(process.stderr, "write").mockImplementation(chunk => {
      const line = String(chunk);
      if (line.startsWith("[agy-bridge] ")) rows.push(JSON.parse(line.slice(13)));
      return originalWrite(chunk);
    });
    cleanups.push(() => { capture.mockRestore(); });
    const wrapper = withAgyTransport({ name: "google" } as ProviderAdapter, {
      adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", apiKey: "fake-token",
      agyTransport: { enabled: true },
    });
    const opening = { model: "gemini-3.8-flash", instructions: "shared workspace instructions", stream: false,
      input: [{ role: "user", content: "shared permissions instructions" }] };
    const requestFor = async (thread: string, next = false) => {
      const parsed = parseRequest({ ...opening, input: next ? [...opening.input,
        { role: "assistant", content: "OK" }, { role: "user", content: "next turn" }] : opening.input });
      parsed._codexOwnThreadId = thread;
      return wrapper.buildRequest(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
    };
    const [a, b] = await Promise.all([requestFor("root-a"), requestFor("root-b")]);
    expect(JSON.parse(a.body).messages).toEqual(JSON.parse(b.body).messages);
    expect(JSON.parse(a.body).system).toEqual(JSON.parse(b.body).system);
    const send = async (body: string) => {
      const response = await bridge.fetch("agy://local/v1/messages", { method: "POST", body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "OK" }] });
    };
    await Promise.all([send(a.body), send(b.body)]);
    const initial = prompted(events());
    expect(initial).toHaveLength(2);
    expect(initial[0]!.sessionId).not.toBe(initial[1]!.sessionId);
    const keys = rows.filter(row => row.action === "session_new" && row.conv).map(row => row.conv);
    expect(new Set(keys).size).toBe(2);
    await send((await requestFor("root-a", true)).body);
    expect(initial.map(event => event.sessionId)).toContain(prompted(events()).at(-1)!.sessionId);
    expect(rows.filter(row => row.action === "session_new" && row.conv)).toHaveLength(2);
  }, 30_000);

  test("a new conversation runs on the process warmed after the previous one, and a new spare follows", async () => {
    const { bridge, events } = fakeBridge();

    expect(await ask(bridge, "first conversation")).toBe("OK");
    // The cold process served the first request; a spare boots right after.
    await until(() => starts(events()).length === 2);
    const spare = starts(events())[1]!.pid;
    await until(() => events().some(event => event.pid === spare && event.event === "session/new"));

    expect(await ask(bridge, "second conversation")).toBe("OK");
    const second = prompted(events()).at(-1)!;
    expect(second.pid).toBe(spare);
    // The spare opened a throwaway session to boot, then the conversation's own.
    expect(events().filter(event => event.pid === spare && event.event === "session/new")).toHaveLength(2);
    await until(() => starts(events()).length === 3);
  }, 30_000);

  test("dropSpare stops the warm process and the next conversation starts cold", async () => {
    const { bridge, events } = fakeBridge();

    await ask(bridge, "first conversation");
    await until(() => starts(events()).length === 2);
    const spare = starts(events())[1]!.pid;
    await bridge.dropSpare();

    await ask(bridge, "second conversation");
    const second = prompted(events()).at(-1)!;
    expect(second.pid).not.toBe(spare);
    expect(starts(events()).map(event => event.pid)).toContain(second.pid);
  }, 30_000);

  test("AGY_BRIDGE_SPARE=0 keeps one process per conversation", async () => {
    const previous = process.env.AGY_BRIDGE_SPARE;
    process.env.AGY_BRIDGE_SPARE = "0";
    cleanups.push(() => {
      if (previous === undefined) delete process.env.AGY_BRIDGE_SPARE;
      else process.env.AGY_BRIDGE_SPARE = previous;
    });
    const { bridge, events } = fakeBridge();

    await ask(bridge, "first conversation");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(starts(events())).toHaveLength(1);
  }, 30_000);
});
