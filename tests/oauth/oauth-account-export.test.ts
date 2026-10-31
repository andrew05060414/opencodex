import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { buildAccountExport, readNativeCodexLogin } from "../../src/oauth/account-export/read";
import { writeAccountExportFile } from "../../src/oauth/account-export/write";
import { cmdAccountExport, cockpitToolsDocument, type AccountExportDeps } from "../../src/cli/account-export";
import { cmdAccount } from "../../src/cli/account";
import type { AuthStore } from "../../src/oauth/store";
import type { CodexAccountCredentialRecord } from "../../src/types/accounts";
import type { OAuthCredentials } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-account-export-")); });
afterEach(() => { removeTreeWithRetry(home); });

const antigravity = "google-antigravity";
const CANARY = "canary-refresh-DO-NOT-LEAK-0123456789";

function credential(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { access: "synthetic-access", refresh: CANARY, expires: 1_800_000_000_000, ...overrides };
}

function store(): AuthStore {
  return {
    [antigravity]: {
      activeAccountId: "acct-1",
      accounts: [
        {
          id: "acct-1",
          alias: "work",
          credential: credential({ email: "user@example.com", projectId: "my-project-1", accountId: "sub-1", plan: "pro", source: "oauth" }),
        },
        { id: "acct-2", credential: credential({ email: "other@example.com", refresh: "second-refresh" }) },
      ],
    },
    anthropic: {
      activeAccountId: "a1",
      accounts: [{ id: "a1", credential: credential({ accountId: "u-1", anthropicIdentity: { v: 1, accountUuid: "x", bearerSha256: "y" } }) }],
    },
  };
}

function nativeAuth(dir: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(body));
}

test("full export carries replayable tokens and drops runtime-only state", () => {
  nativeAuth(join(home, "codex"), {
    auth_mode: "chatgpt",
    tokens: { access_token: "native-access", refresh_token: "native-refresh", account_id: "chatgpt-native" },
  });
  const codexRecords: Record<string, CodexAccountCredentialRecord> = {
    pool1: {
      generation: 3,
      credential: { accessToken: "pool-access", refreshToken: "pool-refresh", expiresAt: 1, chatgptAccountId: "chatgpt-pool" },
    },
    orca1: {
      generation: 1,
      credential: { accessToken: "", refreshToken: "", expiresAt: 1, chatgptAccountId: "x", sourceAuthPath: "/orca/auth.json", sourceSubject: "sub" },
    },
  };

  const document = buildAccountExport({
    loadAuthStore: store,
    loadCodexAccounts: () => codexRecords,
    codexHome: join(home, "codex"),
    now: () => new Date("2026-10-27T00:00:00.000Z"),
  });

  expect(document.version).toBe(1);
  expect(document.exportedAt).toBe("2026-10-27T00:00:00.000Z");
  expect(document.oauth[antigravity]!.activeAccountId).toBe("acct-1");
  expect(document.oauth[antigravity]!.accounts[0]).toEqual({
    id: "acct-1",
    alias: "work",
    active: true,
    credential: { refresh: CANARY, access: "synthetic-access", expires: 1_800_000_000_000, email: "user@example.com", accountId: "sub-1", projectId: "my-project-1" },
  });
  // A non-active account is not marked active, and plan/source/anthropicIdentity never travel.
  expect(document.oauth[antigravity]!.accounts[1]!.active).toBeUndefined();
  expect(JSON.stringify(document)).not.toContain("anthropicIdentity");
  expect(JSON.stringify(document)).not.toContain("\"plan\"");
  expect(document.codex).toEqual([{
    id: "pool1",
    credential: { accessToken: "pool-access", refreshToken: "pool-refresh", expiresAt: 1, chatgptAccountId: "chatgpt-pool" },
  }]);
  expect(document.nativeCodex).toEqual({
    accessToken: "native-access",
    refreshToken: "native-refresh",
    expiresAt: 0,
    chatgptAccountId: "chatgpt-native",
  });
  // Orca owns that grant: it is named as omitted, never exported as an empty credential.
  expect(document.omitted.some(note => note.includes("orca1"))).toBe(true);
});

test("native Codex login distinguishes absent, api-key, malformed and oauth", () => {
  const codexHome = join(home, "codex");
  expect(readNativeCodexLogin({ codexHome })).toEqual({ status: "absent" });

  nativeAuth(codexHome, { auth_mode: "api_key", OPENAI_API_KEY: "sk-test" });
  expect(readNativeCodexLogin({ codexHome })).toEqual({ status: "api-key-only" });

  writeFileSync(join(codexHome, "auth.json"), "not json");
  expect(readNativeCodexLogin({ codexHome })).toEqual({ status: "unreadable" });

  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "a" } }));
  expect(readNativeCodexLogin({ codexHome })).toEqual({ status: "unreadable" });

  // A refresh token is optional in a Codex auth file; report the gap instead of inventing one.
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "a", account_id: "id" } }));
  expect(readNativeCodexLogin({ codexHome })).toEqual({
    status: "ok",
    credential: { accessToken: "a", refreshToken: "", expiresAt: 0, chatgptAccountId: "id" },
  });
});

test("the export file is owner-only and never overwritten without --force", () => {
  const path = join(home, "nested", "accounts.json");
  expect(writeAccountExportFile(path, "{\"a\":1}\n")).toEqual({ ok: true, path });
  expect(readFileSync(path, "utf8")).toBe("{\"a\":1}\n");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

  expect(writeAccountExportFile(path, "second\n")).toEqual({ ok: false, code: "target_exists" });
  expect(readFileSync(path, "utf8")).toBe("{\"a\":1}\n");

  expect(writeAccountExportFile(path, "second\n", { force: true })).toEqual({ ok: true, path });
  expect(readFileSync(path, "utf8")).toBe("second\n");
});

test("a directory or link target is refused before anything is written", () => {
  const dir = join(home, "as-dir");
  mkdirSync(dir);
  expect(writeAccountExportFile(dir, "x")).toEqual({ ok: false, code: "target_is_directory" });

  const real = join(home, "real.json");
  writeFileSync(real, "keep\n");
  chmodSync(real, 0o600);
  const link = join(home, "link.json");
  let linked = true;
  try {
    symlinkSync(real, link);
  } catch {
    // Windows without Developer Mode cannot create a symlink; the directory case still ran.
    linked = false;
  }
  if (linked) {
    expect(writeAccountExportFile(link, "x", { force: true })).toEqual({ ok: false, code: "unsafe_target" });
    expect(readFileSync(real, "utf8")).toBe("keep\n");
  }
  expect(existsSync(real)).toBe(true);
});

test("a temp-file failure never truncates the existing export", () => {
  const path = join(home, "backup.json");
  writeFileSync(path, "previous\n");
  // Occupy the exact temp name with a directory: creating the temp fails, which is the same
  // failure shape as a permissions or disk error during export.
  const blockedTemp = join(home, "blocked.tmp");
  mkdirSync(blockedTemp);
  expect(writeAccountExportFile(path, "replacement\n", { force: true, tempName: () => blockedTemp }))
    .toEqual({ ok: false, code: "write_failed" });
  expect(readFileSync(path, "utf8")).toBe("previous\n");
  expect(existsSync(blockedTemp)).toBe(true);
  // Nothing else was scattered in the destination directory.
  expect(readdirSync(home).sort()).toEqual(["backup.json", "blocked.tmp"]);
});

test("cockpit-tools format emits only rows the importer accepts", () => {
  const document = buildAccountExport({
    loadAuthStore: () => ({
      [antigravity]: {
        activeAccountId: "ok",
        accounts: [
          { id: "ok", credential: credential({ email: "User@Example.com", projectId: "my-project-1" }) },
          { id: "no-email", credential: credential() },
          { id: "padded", credential: credential({ email: " padded@example.com" }) },
          { id: "no-project", credential: credential({ email: "other@example.com" }) },
        ],
      },
    }),
    loadCodexAccounts: () => ({}),
    codexHome: join(home, "absent"),
  });
  expect(cockpitToolsDocument(document)).toEqual([
    { email: "user@example.com", refresh_token: CANARY, project_id: "my-project-1" },
    { email: "other@example.com", refresh_token: CANARY },
  ]);
});

async function capture(parts: string[], deps: AccountExportDeps = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  try {
    const code = await cmdAccountExport(parts, deps);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function exportDeps(overrides: Partial<AccountExportDeps> = {}): AccountExportDeps {
  return {
    loadAuthStore: store,
    loadCodexAccounts: () => ({}),
    codexHome: join(home, "absent"),
    ...overrides,
  };
}

test("--provider narrows the document without touching other stores", async () => {
  const path = join(home, "claude-only.json");
  const result = await capture(["--file", path, "--provider", "anthropic", "--json"], exportDeps());
  expect(result.code).toBe(0);
  const saved = JSON.parse(readFileSync(path, "utf8")) as { oauth: Record<string, unknown> };
  expect(Object.keys(saved.oauth)).toEqual(["anthropic"]);
  expect(result.stdout).not.toContain("user@example.com");
});

test("--provider openai exports only the Codex pool", async () => {
  const path = join(home, "codex-only.json");
  const result = await capture(["--file", path, "--provider", "openai", "--json"], {
    loadAuthStore: store,
    loadCodexAccounts: () => ({
      pool1: { generation: 1, credential: { accessToken: "cx-a", refreshToken: "cx-r", expiresAt: 1, chatgptAccountId: "c1" } },
    }),
    codexHome: join(home, "absent"),
  });
  expect(result.code).toBe(0);
  const saved = JSON.parse(readFileSync(path, "utf8")) as { oauth: unknown; codex: unknown[] };
  expect(saved.oauth).toEqual({});
  expect(saved.codex).toHaveLength(1);
});

test("cliproxyapi writes one file per account beside the requested path", async () => {
  const path = join(home, "auth", "bundle.json");
  const result = await capture(["--file", path, "--format", "cliproxyapi", "--json"], exportDeps());
  expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout) as { ok: boolean; paths: string[] };
  expect(receipt.ok).toBe(true);
  expect(receipt.paths.length).toBe(3);
  for (const written of receipt.paths) {
    expect(existsSync(written)).toBe(true);
    expect(written.startsWith(join(home, "auth", "bundle-"))).toBe(true);
  }
  expect(result.stdout).not.toContain(CANARY);
});

test("a single-credential format refuses a multi-account selection", async () => {
  const path = join(home, "one.json");
  const result = await capture(["--file", path, "--format", "codex-auth"], exportDeps());
  expect(result.code).toBe(1);
  expect(existsSync(path)).toBe(false);
});

test("--json receipt never carries a token, email or account id", async () => {
  const path = join(home, "accounts.json");
  const result = await capture(["--file", path, "--json"], exportDeps());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    format: "full",
    oauthProviders: 2,
    oauthAccounts: 3,
    codexAccounts: 0,
    nativeCodex: false,
    path,
  });
  expect(result.stdout).not.toContain(CANARY);
  expect(result.stdout).not.toContain("user@example.com");
  expect(result.stdout).not.toContain("acct-1");
  // The file itself is the only place the secrets land.
  expect(JSON.parse(readFileSync(path, "utf8")).oauth[antigravity].accounts[0].credential.refresh).toBe(CANARY);
});

test("human output names counts and the file but never the values", async () => {
  const path = join(home, "human.json");
  const result = await capture(["--file", path], exportDeps());
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("3 OAuth account(s) across 2 provider(s)");
  expect(result.stdout).toContain(path);
  expect(result.stdout).not.toContain(CANARY);
  expect(result.stdout).not.toContain("user@example.com");
});

test("--stdout requires --yes, and cockpit-tools writes the importer document", async () => {
  const refused = await capture(["--stdout"], exportDeps());
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("--yes");

  const path = join(home, "cockpit.json");
  const written = await capture(["--file", path, "--format", "cockpit-tools", "--json"], exportDeps());
  expect(written.code).toBe(0);
  expect(JSON.parse(written.stdout)).toMatchObject({ ok: true, format: "cockpit-tools", accounts: 2 });
  expect(written.stdout).not.toContain(CANARY);
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, string>>;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ email: "user@example.com", refresh_token: CANARY, project_id: "my-project-1" });
});

test("arguments are rejected before any file is touched", async () => {
  const path = join(home, "existing.json");
  writeFileSync(path, "keep\n");
  const exists = await capture(["--file", path], exportDeps());
  expect(exists.code).toBe(1);
  expect(readFileSync(path, "utf8")).toBe("keep\n");
  expect(exists.stderr).toContain("exists");

  const forced = await capture(["--file", path, "--force"], exportDeps());
  expect(forced.code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);

  expect((await capture(["--file", path, "--stdout"], exportDeps())).code).toBe(1);
  expect((await capture(["--format", "yaml", "--file", path], exportDeps())).code).toBe(1);
  expect((await capture(["--file", path, "--file", path], exportDeps())).code).toBe(1);
  expect((await capture([], exportDeps())).code).toBe(1);
});

test("the account dispatcher routes export without contacting a proxy", async () => {
  const path = join(home, "dispatched.json");
  const originalLog = console.log;
  const originalError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  try {
    // A management-backed subcommand would need a live proxy here; an unrelated flag also
    // proves the dispatcher reached the local handler rather than a network path.
    const code = await cmdAccount(["export", "--file", path, "--bogus"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unexpected argument");
    expect(err.join("\n")).not.toContain("Proxy is not running");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  expect(existsSync(path)).toBe(false);
});

