import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAccountExport } from "../../src/oauth/account-export/read";
import { formatWriters } from "../../src/oauth/account-export/format";
import type { AuthStore } from "../../src/oauth/store";
import type { CodexAccountCredentialRecord } from "../../src/types/accounts";
import type { OAuthCredentials } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-export-formats-")); });
afterEach(() => { removeTreeWithRetry(home); });

function credential(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { access: "access-fixture", refresh: "refresh-fixture", expires: 1_800_000_000_000, ...overrides };
}

const store = (): AuthStore => ({
  anthropic: {
    activeAccountId: "claude-1",
    accounts: [
      { id: "claude-1", alias: "work", credential: credential({ accountId: "uuid-1" }) },
      { id: "claude-2", credential: credential({ accountId: "uuid-2" }) },
    ],
  },
  "google-antigravity": {
    activeAccountId: "ag-1",
    accounts: [{ id: "ag-1", credential: credential({ email: "user@example.com", projectId: "my-project-1" }) }],
  },
  xai: { activeAccountId: "grok-1", accounts: [{ id: "grok-1", credential: credential({ email: "grok@example.com" }) }] },
});

const codex = (): Record<string, CodexAccountCredentialRecord> => ({
  pool1: { generation: 1, credential: { accessToken: "cx-access", refreshToken: "cx-refresh", expiresAt: 1_800_000_000_000, chatgptAccountId: "chatgpt-1" } },
});

function build(selection?: { providers?: string[]; accounts?: string[] }): ReturnType<typeof buildAccountExport> {
  return buildAccountExport({
    loadAuthStore: store,
    loadCodexAccounts: codex,
    codexHome: join(home, "absent"),
    selection,
    now: () => new Date("2026-10-28T00:00:00.000Z"),
  });
}

test("a provider selection exports only that provider", () => {
  const document = build({ providers: ["anthropic"] });
  expect(Object.keys(document.oauth)).toEqual(["anthropic"]);
  expect(document.oauth.anthropic!.accounts.map(account => account.id)).toEqual(["claude-1", "claude-2"]);
  expect(document.codex).toEqual([]);
});

test("an account selection accepts an id or its alias", () => {
  expect(build({ accounts: ["anthropic:work"] }).oauth.anthropic!.accounts.map(account => account.id)).toEqual(["claude-1"]);
  expect(build({ accounts: ["anthropic:claude-2"] }).oauth.anthropic!.accounts.map(account => account.id)).toEqual(["claude-2"]);
  // A Codex pool account is addressed through the `openai` provider key.
  const codexOnly = build({ accounts: ["openai:pool1"] });
  expect(codexOnly.codex.map(account => account.id)).toEqual(["pool1"]);
  expect(codexOnly.oauth).toEqual({});
});

test("the Codex pool is selectable as `openai`, separately from OAuth accounts", () => {
  const document = build({ providers: ["openai"] });
  expect(document.codex.map(account => account.id)).toEqual(["pool1"]);
  expect(document.oauth).toEqual({});
});

test("an empty selection still exports nothing for formats that need a credential", () => {
  const document = build({ providers: ["nonexistent"] });
  expect(formatWriters("codex-auth", document)).toEqual({ ok: false, code: "format_unsupported_selection" });
  expect(formatWriters("cliproxyapi", document)).toEqual({ ok: false, code: "format_unsupported_selection" });
});

test("codex-auth matches the Codex CLI auth.json field names", () => {
  const written = formatWriters("codex-auth", build({ accounts: ["openai:pool1"] }));
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.files).toHaveLength(1);
  const body = JSON.parse(written.files[0]!.content) as Record<string, unknown>;
  expect(body).toMatchObject({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: "cx-access", refresh_token: "cx-refresh", account_id: "chatgpt-1" },
  });
  expect(typeof body.last_refresh).toBe("string");
});

test("codex-auth refuses a multi-account selection instead of picking one", () => {
  expect(formatWriters("codex-auth", build())).toEqual({ ok: false, code: "format_requires_one_account" });
});

test("claude-credentials matches the Claude Code envelope", () => {
  const written = formatWriters("claude-credentials", build({ accounts: ["anthropic:claude-1"] }));
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  const body = JSON.parse(written.files[0]!.content) as { claudeAiOauth?: Record<string, unknown> };
  expect(body.claudeAiOauth).toMatchObject({
    accessToken: "access-fixture",
    refreshToken: "refresh-fixture",
    expiresAt: 1_800_000_000_000,
  });
  expect(written.files[0]!.filename.endsWith(".credentials.json")).toBe(true);
});

test("cliproxyapi emits one typed file per account", () => {
  const written = formatWriters("cliproxyapi", build());
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  // 1 Codex + 2 Anthropic + 1 Antigravity + 1 xAI.
  expect(written.files).toHaveLength(5);
  const codexFile = written.files.find(file => file.filename.startsWith("codex-"))!;
  expect(JSON.parse(codexFile.content)).toMatchObject({ type: "codex", access_token: "cx-access", refresh_token: "cx-refresh", account_id: "chatgpt-1" });
  const claudeFile = written.files.find(file => file.filename.startsWith("claude-"))!;
  expect(JSON.parse(claudeFile.content)).toMatchObject({ type: "claude", refresh_token: "refresh-fixture" });
  const antigravityFile = written.files.find(file => file.filename.startsWith("antigravity-"))!;
  expect(JSON.parse(antigravityFile.content)).toMatchObject({ type: "antigravity", project_id: "my-project-1", email: "user@example.com" });
  expect(new Set(written.files.map(file => file.filename)).size).toBe(5);
});

test("the full document keeps its own versioned shape for any selection", () => {
  const written = formatWriters("full", build({ providers: ["anthropic"] }));
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(JSON.parse(written.files[0]!.content)).toMatchObject({ version: 1, codex: [] });
});
