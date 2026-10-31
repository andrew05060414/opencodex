/**
 * Account export document (`ocx.account-export/1`).
 *
 * This is the shape `ocx account export` writes and the import side can grow into. It is
 * deliberately independent of the on-disk stores: those carry generations, mutation epochs,
 * quota publication ids and pause bookkeeping that mean nothing on another machine, and
 * copying them would make a restore look like a live refresh to every fence in this runtime.
 *
 * Secret material appears here in plaintext because the whole point is a credential that can be
 * moved. The writer keeps the file owner-only and the CLI never prints the document to stdout
 * unless the operator names `-` and asked for it explicitly.
 */
import type { OAuthCredentials } from "../types";

export const ACCOUNT_EXPORT_VERSION = 1;

/** Provider-level fields a migration needs; never the whole credential object. */
export type ExportedOAuthCredential = Pick<
  OAuthCredentials,
  "refresh" | "access" | "expires" | "email" | "accountId" | "projectId" | "apiBaseUrl"
>;

export interface ExportedOAuthAccount {
  /** Local store id; an import may keep it for alias/routing continuity. */
  id: string;
  alias?: string;
  active?: boolean;
  credential: ExportedOAuthCredential;
}

export interface ExportedProviderAccounts {
  activeAccountId?: string;
  accounts: ExportedOAuthAccount[];
}

export interface ExportedCodexAccount {
  id: string;
  active?: boolean;
  credential: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    chatgptAccountId: string;
  };
}

export interface AccountExportDocument {
  version: typeof ACCOUNT_EXPORT_VERSION;
  exportedAt: string;
  /** OAuth providers from `auth.json`. */
  oauth: Record<string, ExportedProviderAccounts>;
  /** Codex Pool accounts from `codex-accounts.json`. */
  codex: ExportedCodexAccount[];
  /**
   * The signed-in `$CODEX_HOME/auth.json` login, when that file holds an OAuth grant. It is not a
   * Pool account and not ours to rotate; carrying it separately keeps a reader from mistaking the
   * signed-in identity for one more pool row.
   */
  nativeCodex?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    chatgptAccountId: string;
  };
  /**
   * Notes for things NOT in this document. Plain strings, no secrets: they exist so the reader
   * does not mistake an incomplete file for a complete backup.
   */
  omitted: string[];
}

/**
 * Interchange formats other tools already read. `full` is this project's own document; the
 * others are projections onto a shape a specific consumer accepts without translation.
 */
export type AccountExportFormat =
  | "full"
  | "cockpit-tools"
  | "codex-auth"
  | "claude-credentials"
  | "cliproxyapi";

/** Selection narrows both the account list and which providers are read. */
export interface AccountExportSelection {
  /** Provider keys to include (`openai` means the Codex pool). Omitted = all. */
  providers?: readonly string[];
  /** Exact `provider:accountIdOrAlias` pairs. Omitted = every account of the included providers. */
  accounts?: readonly string[];
}

/** One file the caller should write; `content` is already serialized JSON with a trailing newline. */
export interface AccountExportFile {
  filename: string;
  content: string;
}

/** Provider API keys live in config.json; `ocx config export` already writes them. */
export const ACCOUNT_EXPORT_OMITTED = [
  "provider API keys and OAuth account slots: stored in config.json, written by `ocx config export`",
  "API keys kept in the OS credential store: only a keychain reference is recorded, resolve it on the source machine",
  "paused, cooldown, quota and usage state: runtime observations, rebuilt on the destination",
] as const;

/** Select only the fields another install can use; anything unknown is dropped, not copied. */
export function projectCredential(credential: OAuthCredentials): ExportedOAuthCredential {
  const projected: ExportedOAuthCredential = {
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
  if (credential.email !== undefined) projected.email = credential.email;
  if (credential.accountId !== undefined) projected.accountId = credential.accountId;
  if (credential.projectId !== undefined) projected.projectId = credential.projectId;
  if (credential.apiBaseUrl !== undefined) projected.apiBaseUrl = credential.apiBaseUrl;
  return projected;
}
