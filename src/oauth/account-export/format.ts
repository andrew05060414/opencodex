/**
 * Projections of the export document onto formats other tools already import.
 *
 * Each writer is a pure function of the selected document, so a format's field set can be pinned
 * by a test and a new format is one function plus one case — never a second data-gathering path.
 * Formats that address ONE account (Codex `auth.json`, Claude credentials) receive a document
 * already narrowed to that account, and refuse a document holding several: silently writing the
 * first would export a credential the operator did not pick.
 */
import type {
  AccountExportDocument,
  AccountExportFile,
  AccountExportFormat,
} from "./document";

export type FormatWriteResult =
  | { ok: true; files: AccountExportFile[] }
  | { ok: false; code: "format_requires_one_account" | "format_unsupported_selection" };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A filesystem-safe stem: providers and aliases may hold spaces or slashes. */
export function exportFileStem(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "account";
}

export function formatExtension(format: AccountExportFormat): string {
  return format === "full" || format === "cockpit-tools" ? "json" : format === "claude-credentials" ? "credentials.json" : "json";
}

function selectedOauthAccounts(document: AccountExportDocument): Array<{ provider: string; set: string; id: string }> {
  return Object.entries(document.oauth).flatMap(([provider, set]) =>
    set.accounts.map(account => ({ provider, set: provider, id: account.id })));
}

/** Fix a small formatting bug: keep the helper shape meaningful for the one-account check. */
const countAccounts = (document: AccountExportDocument): number =>
  selectedOauthAccounts(document).length + document.codex.length;

export function formatWriters(format: AccountExportFormat, document: AccountExportDocument): FormatWriteResult {
  if (format === "full") {
    return { ok: true, files: [{ filename: "ocx-accounts.json", content: json(document) }] };
  }
  if (format === "cockpit-tools") {
    const rows: Array<Record<string, string>> = [];
    for (const account of document.oauth["google-antigravity"]?.accounts ?? []) {
      const email = account.credential.email;
      const refresh = account.credential.refresh;
      if (typeof email !== "string" || email.length === 0 || email !== email.trim() || /[\x00-\x20\x7f]/.test(email)) continue;
      if (typeof refresh !== "string" || refresh.length === 0 || /[\s\x7f]/.test(refresh)) continue;
      rows.push({ email: email.toLowerCase(), refresh_token: refresh, ...(account.credential.projectId ? { project_id: account.credential.projectId } : {}) });
    }
    // The Cockpit import takes one array, so this format stays a single file regardless of selection.
    return { ok: true, files: [{ filename: "antigravity-cockpit-tools.json", content: json(rows) }] };
  }

  if (format === "codex-auth") {
    const total = countAccounts(document);
    if (total === 0) return { ok: false, code: "format_unsupported_selection" };
    if (total > 1) return { ok: false, code: "format_requires_one_account" };
    const entry = document.codex[0];
    if (!entry) return { ok: false, code: "format_unsupported_selection" };
    // Codex CLI / Codex Switcher both read this shape verbatim; last_refresh is what makes a
    // migrated login look freshly observed instead of decades stale.
    return {
      ok: true,
      files: [{
        filename: `${exportFileStem(entry.id)}.codex-auth.json`,
        content: json({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: entry.credential.accessToken,
            refresh_token: entry.credential.refreshToken,
            account_id: entry.credential.chatgptAccountId,
          },
          last_refresh: new Date().toISOString(),
        }),
      }],
    };
  }

  if (format === "claude-credentials") {
    const total = selectedOauthAccounts(document).length + document.codex.length;
    if (total === 0) return { ok: false, code: "format_unsupported_selection" };
    if (total > 1) return { ok: false, code: "format_requires_one_account" };
    const entry = Object.entries(document.oauth).flatMap(([provider, set]) => set.accounts.map(account => ({ provider, account })))[0];
    if (!entry) return { ok: false, code: "format_unsupported_selection" };
    // Claude Code writes exactly this envelope to <config-dir>/.credentials.json and its macOS
    // Keychain item; expiresAt is epoch milliseconds, not seconds.
    return {
      ok: true,
      files: [{
        filename: `${exportFileStem(entry.provider)}-${exportFileStem(entry.account.id)}.credentials.json`,
        content: json({
          claudeAiOauth: {
            accessToken: entry.account.credential.access,
            refreshToken: entry.account.credential.refresh,
            expiresAt: entry.account.credential.expires,
            scopes: ["user:inference", "user:profile"],
          },
        }),
      }],
    };
  }

  // CLIProxyAPI keeps one top-level file per credential in its auth-dir, named by a stable key and
  // discriminated by `type`. Multiple selected accounts therefore become multiple files.
  const files: AccountExportFile[] = [];
  for (const entry of document.codex) {
    files.push({
      filename: `codex-${exportFileStem(entry.id)}.json`,
      content: json({
        type: "codex",
        access_token: entry.credential.accessToken,
        refresh_token: entry.credential.refreshToken,
        account_id: entry.credential.chatgptAccountId,
        expired: new Date(entry.credential.expiresAt).toISOString(),
        last_refresh: new Date().toISOString(),
      }),
    });
  }
  for (const [provider, set] of Object.entries(document.oauth)) {
    const kind = provider.startsWith("anthropic") ? "claude" : provider === "google-antigravity" ? "antigravity" : provider === "xai" ? "xai" : "generic";
    for (const account of set.accounts) {
      files.push({
        filename: `${kind}-${exportFileStem(provider)}-${exportFileStem(account.id)}.json`,
        content: json({
          type: kind,
          provider,
          access_token: account.credential.access,
          refresh_token: account.credential.refresh,
          ...(account.credential.email ? { email: account.credential.email } : {}),
          ...(account.credential.accountId ? { account_id: account.credential.accountId } : {}),
          ...(account.credential.projectId ? { project_id: account.credential.projectId } : {}),
          expired: new Date(account.credential.expires).toISOString(),
          last_refresh: new Date().toISOString(),
        }),
      });
    }
  }
  return files.length > 0 ? { ok: true, files } : { ok: false, code: "format_unsupported_selection" };
}

export const ACCOUNT_EXPORT_FORMATS: readonly AccountExportFormat[] = [
  "full",
  "cockpit-tools",
  "codex-auth",
  "claude-credentials",
  "cliproxyapi",
];
