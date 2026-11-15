import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgyBridge, type AgyBridge } from "../../../src/adapters/agy-acp/vendor/index.mjs";
import { fixturePath } from "../../helpers/repo-root";

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
