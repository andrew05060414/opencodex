import { describe, expect, test } from "bun:test";
import { agyChildEnv, createAgyBridgePool, type AgyBridge, type AgyBridgeOptions } from "../../../src/adapters/agy-acp/bridge-pool";

function fakeBridge(onShutdown: () => void = () => {}): AgyBridge {
  return { fetch: async () => new Response("ok"), shutdown: async () => { onShutdown(); } };
}

describe("agy bridge pool", () => {
  test("one bridge per account is created once and reused", async () => {
    const seen: AgyBridgeOptions[] = [];
    const pool = createAgyBridgePool(options => { seen.push(options); return fakeBridge(); });

    const first = await pool.bridgeFor("acct-a", "/homes/acct-a");
    const again = await pool.bridgeFor("acct-a", "/homes/acct-a");
    const other = await pool.bridgeFor("acct-b", "/homes/acct-b");

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(seen.map(options => options.home)).toEqual(["/homes/acct-a", "/homes/acct-b"]);
  });

  test("the child environment is only HOME, USERPROFILE and SSH_CONNECTION, with no PATH", async () => {
    const seen: AgyBridgeOptions[] = [];
    const pool = createAgyBridgePool(options => { seen.push(options); return fakeBridge(); });

    await pool.bridgeFor("acct-a", "/homes/acct-a", "/opt/agy/bin/agy");

    expect(Object.keys(seen[0]!.env).sort()).toEqual(["HOME", "SSH_CONNECTION", "USERPROFILE"]);
    expect(seen[0]!.env["HOME"]).toBe("/homes/acct-a");
    expect(seen[0]!.env).not.toHaveProperty("PATH");
    expect(seen[0]!.env).not.toHaveProperty("Path");
    expect(agyChildEnv("/homes/acct-a")).not.toHaveProperty("PATH");
    expect(seen[0]!.agyPath).toBe("/opt/agy/bin/agy");
    expect(seen[0]!.stateFile).toBe("/homes/acct-a/bridge-state.json");
  });

  test("a different agy binary gets its own bridge", async () => {
    let created = 0;
    const pool = createAgyBridgePool(() => { created += 1; return fakeBridge(); });

    await pool.bridgeFor("acct-a", "/homes/acct-a");
    await pool.bridgeFor("acct-a", "/homes/acct-a", "/opt/agy");

    expect(created).toBe(2);
  });

  test("a failed creation is retried on the next call", async () => {
    let attempts = 0;
    const bridge = fakeBridge();
    const pool = createAgyBridgePool(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("factory failed");
      return bridge;
    });

    await expect(pool.bridgeFor("acct-a", "/homes/acct-a")).rejects.toThrow("factory failed");
    expect(await pool.bridgeFor("acct-a", "/homes/acct-a")).toBe(bridge);
    expect(attempts).toBe(2);
  });

  test("shutdown stops every bridge, even when one of them fails to stop", async () => {
    const stopped: string[] = [];
    const pool = createAgyBridgePool(options => ({
      fetch: async () => new Response("ok"),
      shutdown: async () => {
        stopped.push(options.home);
        if (options.home === "/homes/acct-a") throw new Error("stuck");
      },
    }));
    await pool.bridgeFor("acct-a", "/homes/acct-a");
    await pool.bridgeFor("acct-b", "/homes/acct-b");

    await pool.shutdown();

    expect(stopped.sort()).toEqual(["/homes/acct-a", "/homes/acct-b"]);
  });

  test("after shutdown the next request creates a fresh bridge", async () => {
    let created = 0;
    const pool = createAgyBridgePool(() => { created += 1; return fakeBridge(); });
    await pool.bridgeFor("acct-a", "/homes/acct-a");
    await pool.shutdown();

    await pool.bridgeFor("acct-a", "/homes/acct-a");

    expect(created).toBe(2);
  });
});
