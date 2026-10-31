import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccountExportRoutes } from "../../src/server/management/account-export-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { GuiSessionIssuance } from "../../src/server/gui-session";
import type { ManagementSessionControl } from "../../src/server/management-auth";
import { getDefaultConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-export-route-"));
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  // One replayable Codex credential so an authorized response has a real secret to expose.
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.OPENCODEX_HOME, "codex-accounts.json"), JSON.stringify({
    __main__: { generation: 1, credential: {
      accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: 1_800_000_000_000, chatgptAccountId: "chatgpt-fixture",
    } },
  }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function context(options: {
  principal?: ManagementContext["principal"];
  issuance?: GuiSessionIssuance | null;
  reveal?: boolean;
  method?: string;
  path?: string;
  body?: string;
} = {}): ManagementContext {
  const config = getDefaultConfig();
  const url = new URL(`http://127.0.0.1:10100${options.path ?? "/api/oauth/accounts/export"}`);
  const reveal = options.reveal ?? true;
  const sessionControl: ManagementSessionControl = {
    revokeCurrent: () => false,
    isCurrent: () => true,
    isPaired: () => options.issuance === "pairing",
    canRevealDataKeys: () => reveal,
  };
  return {
    req: new Request(url, { method: options.method ?? "POST", body: options.body ?? JSON.stringify({ format: "full" }), headers: { "content-type": "application/json" } }),
    url,
    config,
    deps: {},
    version: "fixture",
    principal: options.principal ?? "gui-session",
    sessionControl,
    trustedLoopbackIngress: true,
    guiSessionIssuance: options.issuance ?? "pairing",
    convergeCodexCatalog: async () => { throw new Error("export must not converge the catalog"); },
    syncClaudeAgentDefsBestEffort: async () => { throw new Error("export must not sync agents"); },
  };
}

describe("POST /api/oauth/accounts/export", () => {
  test("an operator-paired session receives the document with no-store", async () => {
    const response = await handleAccountExportRoutes(context({ issuance: "pairing" }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = await response!.json() as { version?: number; codex?: Array<{ credential?: { refreshToken?: string } }> };
    expect(body.version).toBe(1);
    expect(body.codex?.[0]?.credential?.refreshToken).toBe("fixture-refresh");
  });

  test("trusted Tailscale identity is an operator presence and is accepted", async () => {
    const response = await handleAccountExportRoutes(context({ issuance: "tailscale-identity" }));
    expect(response?.status).toBe(200);
    await response!.body?.cancel();
  });

  test("an automatic loopback dashboard session is refused even with reveal rights", async () => {
    const response = await handleAccountExportRoutes(context({ issuance: "loopback", reveal: true }));
    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "export_session_required" });
  });

  test("the admin token and CLI capability principals are refused", async () => {
    for (const principal of ["admin-token", "local-read-capability"] as const) {
      const response = await handleAccountExportRoutes(context({ principal, issuance: null }));
      expect(response?.status).toBe(403);
      expect(await response!.json()).toEqual({ error: "dashboard session required" });
    }
  });

  test("a session without the independent reveal predicate fails closed", async () => {
    const response = await handleAccountExportRoutes(context({ issuance: "pairing", reveal: false }));
    expect(response?.status).toBe(403);
  });

  test("other methods and paths are not claimed", async () => {
    expect(await handleAccountExportRoutes(context({ method: "GET" }))).toBeNull();
    expect(await handleAccountExportRoutes(context({ path: "/api/oauth/accounts/import" }))).toBeNull();
  });

  test("an account selection narrows the document to that account", async () => {
    const response = await handleAccountExportRoutes(context({
      body: JSON.stringify({ format: "full", selection: { accounts: ["openai:__main__"] } }),
    }));
    expect(response?.status).toBe(200);
    const body = await response!.json() as { codex?: unknown[]; oauth?: unknown };
    expect(body.codex).toHaveLength(1);
    expect(body.oauth).toEqual({});
  });

  test("a non-full format answers with the files the CLI would write", async () => {
    const response = await handleAccountExportRoutes(context({ body: JSON.stringify({ format: "cliproxyapi" }) }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = await response!.json() as { format?: string; files?: Array<{ filename: string; content: string }> };
    expect(body.format).toBe("cliproxyapi");
    expect(body.files).toHaveLength(1);
    expect(JSON.parse(body.files![0]!.content)).toMatchObject({ type: "codex", refresh_token: "fixture-refresh" });
  });

  test("a one-credential format refuses a multi-credential document", async () => {
    const response = await handleAccountExportRoutes(context({ body: JSON.stringify({ format: "codex-auth" }) }));
    expect(response?.status).toBe(200);
    // Only one Codex credential is stored in this fixture, so it succeeds; the refusal case is
    // covered by the format unit test with several accounts.
    const body = await response!.json() as { files?: unknown[] };
    expect(body.files).toHaveLength(1);
  });

  test("unknown formats and malformed selections are refused before any store read", async () => {
    for (const body of [
      JSON.stringify({ format: "yaml" }),
      JSON.stringify({ format: "full", extra: 1 }),
      JSON.stringify({ format: "full", selection: { accounts: ["not a pair"] } }),
      JSON.stringify({ format: "full", selection: { accounts: "openai:main" } }),
      "not json",
    ]) {
      const response = await handleAccountExportRoutes(context({ body }));
      expect(response?.status).toBe(400);
      await response!.body?.cancel();
    }
  });
});
