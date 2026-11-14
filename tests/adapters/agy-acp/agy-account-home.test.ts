import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyAccountHome, ensureAgyTokenFile, type AgyAccountRef } from "../../../src/adapters/agy-acp/account-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const prevHome = process.env["OPENCODEX_HOME"];
let temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-agy-home-"));
  temps.push(dir);
  return dir;
}

function account(overrides: Partial<AgyAccountRef["credential"]> = {}): AgyAccountRef {
  return {
    id: "acct-1",
    credential: {
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      expires: NOW + HOUR,
      email: "fake@example.test",
      ...overrides,
    },
  };
}

function tokenFile(home: string): string {
  return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function writeExisting(home: string, refresh: string, expiry: Date): void {
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(tokenFile(home), JSON.stringify({
    token: { access_token: "agy-refreshed", token_type: "Bearer", refresh_token: refresh, expiry: expiry.toISOString(), expires_in: 1 },
    auth_method: "consumer",
    id_token_email: "",
    writer_id: "existing-writer",
  }));
}

beforeEach(() => {
  process.env["OPENCODEX_HOME"] = tempDir();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["OPENCODEX_HOME"];
  else process.env["OPENCODEX_HOME"] = prevHome;
  for (const dir of temps) removeTreeWithRetry(dir);
  temps = [];
});

describe("agy account home", () => {
  test("each account gets its own home under the OpenCodex home", () => {
    expect(agyAccountHome("acct-1")).toBe(join(process.env["OPENCODEX_HOME"]!, "agy-homes", "acct-1"));
  });

  test.each(["../escape", "a/b", "a\\b", "", "x".repeat(81)])("rejects the unsafe account id %p", id => {
    expect(() => agyAccountHome(id)).toThrow("not a safe directory name");
  });
});

describe("agy token file", () => {
  test("writes exactly the keys agy reads, with the OCX credential", async () => {
    const home = tempDir();
    expect(await ensureAgyTokenFile(account(), home, NOW)).toBe("written");

    const file = JSON.parse(readFileSync(tokenFile(home), "utf8")) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["auth_method", "id_token_email", "token", "writer_id"]);
    expect(file["token"]).toEqual({
      access_token: "fake-access-token",
      token_type: "Bearer",
      refresh_token: "fake-refresh-token",
      expiry: new Date(NOW + HOUR).toISOString(),
      expires_in: 3600,
    });
    expect(file["auth_method"]).toBe("consumer");
    expect(file["id_token_email"]).toBe("fake@example.test");
    expect(typeof file["writer_id"]).toBe("string");
    expect(file["writer_id"]).not.toBe("");
  });

  test("skips the write when the file holds the same refresh grant and a later expiry", async () => {
    const home = tempDir();
    writeExisting(home, "fake-refresh-token", new Date(NOW + 2 * HOUR));
    const before = readFileSync(tokenFile(home), "utf8");

    expect(await ensureAgyTokenFile(account(), home, NOW)).toBe("current");
    expect(readFileSync(tokenFile(home), "utf8")).toBe(before);
  });

  test("skips the write when the expiries are equal", async () => {
    const home = tempDir();
    writeExisting(home, "fake-refresh-token", new Date(NOW + HOUR));

    expect(await ensureAgyTokenFile(account(), home, NOW)).toBe("current");
  });

  test("rewrites when the file belongs to another refresh grant", async () => {
    const home = tempDir();
    writeExisting(home, "other-refresh-token", new Date(NOW + 2 * HOUR));

    expect(await ensureAgyTokenFile(account(), home, NOW)).toBe("written");
    const file = JSON.parse(readFileSync(tokenFile(home), "utf8")) as { token: { refresh_token: string; access_token: string } };
    expect(file.token.refresh_token).toBe("fake-refresh-token");
    expect(file.token.access_token).toBe("fake-access-token");
  });

  test("rewrites when OCX holds a later expiry for the same grant, and keeps the writer id", async () => {
    const home = tempDir();
    writeExisting(home, "fake-refresh-token", new Date(NOW + HOUR));

    expect(await ensureAgyTokenFile(account({ expires: NOW + 2 * HOUR }), home, NOW)).toBe("written");
    const file = JSON.parse(readFileSync(tokenFile(home), "utf8")) as { token: { expiry: string }; writer_id: string };
    expect(file.token.expiry).toBe(new Date(NOW + 2 * HOUR).toISOString());
    expect(file.writer_id).toBe("existing-writer");
  });
});
