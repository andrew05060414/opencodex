/**
 * Local reads for `ocx account export`.
 *
 * Everything here is a read of the two credential files plus the native Codex home. Nothing
 * calls a management route, a provider endpoint, or a token refresh: an export must not rotate
 * the very refresh token it is exporting, and it must work while the proxy is stopped.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAuthStore } from "../store";
import { resolveCodexHomeDir } from "../../codex/home";
import { peekCodexAccountRecordStore } from "../../codex/account-store";
import type { AuthStore } from "../store";
import {
  ACCOUNT_EXPORT_OMITTED,
  ACCOUNT_EXPORT_VERSION,
  projectCredential,
  type AccountExportDocument,
  type AccountExportSelection,
  type ExportedCodexAccount,
  type ExportedOAuthAccount,
  type ExportedProviderAccounts,
} from "./document";

/**
 * The signed-in Codex login is selectable as one account. It has no store id of its own, so this
 * fixed reserved id is its handle; pool ids never collide with it because they are generated ids.
 */
export const NATIVE_CODEX_ACCOUNT_ID = "native";
export const CODEX_POOL_PROVIDER = "openai";

/** Bounded read: the auth store is small, and an export must not slurp an arbitrary file. */
export const ACCOUNT_EXPORT_MAX_STORE_BYTES = 32 * 1024 * 1024;

export interface AccountExportReadDeps {
  /** Normalized `auth.json` (tests inject one; production reads the real store). */
  loadAuthStore?: () => AuthStore;
  /** Codex Pool records, already normalized by `account-store`. */
  loadCodexAccounts?: () => ReturnType<typeof peekCodexAccountRecordStore>;
  /** The native Codex home whose `auth.json` is the signed-in Codex App/CLI login. */
  codexHome?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  now?: () => Date;
  /** Narrow what is exported. Absent means every stored credential. */
  selection?: AccountExportSelection;
}

interface NativeCodexToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  chatgptAccountId: string;
}

export type NativeCodexRead =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "api-key-only" }
  | { status: "ok"; credential: NativeCodexToken };

function decodeJwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the native `$CODEX_HOME/auth.json` login without treating an unexpected shape as empty.
 *
 * The refresh token is optional in a Codex auth file: a login that was already refreshed by
 * something else can carry only an access token. Reporting that as `ok` with an empty refresh
 * token is honest; inventing one or dropping the account silently is not.
 */
export function readNativeCodexLogin(deps: AccountExportReadDeps = {}): NativeCodexRead {
  const home = deps.codexHome ?? resolveCodexHomeDir();
  const path = join(home, "auth.json");
  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return { status: "absent" };
  const read = deps.readFile ?? ((file: string) => {
    if (statSync(file).size > ACCOUNT_EXPORT_MAX_STORE_BYTES) throw new Error("oversized");
    return readFileSync(file, "utf8");
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch {
    return { status: "unreadable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unreadable" };
  const envelope = parsed as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
  if (envelope.tokens == null) {
    return envelope.auth_mode === "api_key" && typeof envelope.OPENAI_API_KEY === "string"
      ? { status: "api-key-only" }
      : { status: "unreadable" };
  }
  if (typeof envelope.tokens !== "object" || Array.isArray(envelope.tokens)) return { status: "unreadable" };
  const tokens = envelope.tokens as { access_token?: unknown; refresh_token?: unknown; account_id?: unknown };
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0
    || typeof tokens.account_id !== "string" || tokens.account_id.length === 0) {
    return { status: "unreadable" };
  }
  return {
    status: "ok",
    credential: {
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
      expiresAt: decodeJwtExpiry(tokens.access_token) ?? 0,
      chatgptAccountId: tokens.account_id,
    },
  };
}

function exportOAuthAccounts(store: AuthStore): { oauth: Record<string, ExportedProviderAccounts>; skipped: number } {
  const oauth: Record<string, ExportedProviderAccounts> = {};
  let skipped = 0;
  for (const [provider, set] of Object.entries(store)) {
    const accounts: ExportedOAuthAccount[] = [];
    for (const account of set.accounts) {
      // A credential without both halves cannot be replayed on another install.
      if (typeof account.credential?.refresh !== "string" || typeof account.credential.access !== "string"
        || account.credential.refresh.length === 0) {
        skipped += 1;
        continue;
      }
      accounts.push({
        id: account.id,
        ...(account.alias ? { alias: account.alias } : {}),
        ...(account.id === set.activeAccountId ? { active: true } : {}),
        credential: projectCredential(account.credential),
      });
    }
    if (accounts.length > 0) oauth[provider] = { activeAccountId: set.activeAccountId, accounts };
  }
  return { oauth, skipped };
}

function exportCodexAccounts(
  records: ReturnType<typeof peekCodexAccountRecordStore>,
): { codex: ExportedCodexAccount[]; omitted: string[] } {
  const codex: ExportedCodexAccount[] = [];
  const omitted: string[] = [];
  for (const [id, record] of Object.entries(records)) {
    if (record.deletedAt != null || !record.credential) continue;
    if (record.credential.sourceAuthPath) {
      // Orca owns this grant; its refresh token is not ours to copy. The access token is also a
      // moving value, so exporting it would freeze a credential another app keeps rotating.
      omitted.push(`codex ${id}: linked to an external Orca auth file; relink it on the destination with \`ocx account import-orca\``);
      continue;
    }
    codex.push({
      id,
      ...(id === "__main__" ? { active: true } : {}),
      credential: {
        accessToken: record.credential.accessToken,
        refreshToken: record.credential.refreshToken,
        expiresAt: record.credential.expiresAt,
        chatgptAccountId: record.credential.chatgptAccountId,
      },
    });
  }
  return { codex, omitted };
}

/** Build the export document from local state only. */
export function buildAccountExport(deps: AccountExportReadDeps = {}): AccountExportDocument {
  const loadStore = deps.loadAuthStore ?? loadAuthStore;
  const loadCodex = deps.loadCodexAccounts ?? peekCodexAccountRecordStore;
  const selection = deps.selection;
  const selected = selectionFilter(selection);
  const { oauth: allOauth, skipped } = exportOAuthAccounts(loadStore());
  const { codex: allCodex, omitted: codexOmitted } = exportCodexAccounts(loadCodex());
  const oauth = selected.oauth
    ? Object.fromEntries(Object.entries(allOauth)
      .filter(([provider]) => selected.providers ? selected.providers.has(provider) : true)
      .map(([provider, set]): [string, ExportedProviderAccounts] => [provider, {
        ...set,
        accounts: set.accounts.filter(account => selected.accounts
          ? selected.accounts.has(`${provider}:${account.id}`)
            || (account.alias ? selected.accounts.has(`${provider}:${account.alias}`) : false)
          : true),
      }])
      .filter(([, set]) => set.accounts.length > 0))
    : {};
  const codex = selected.codex
    ? allCodex.filter(account => selected.accounts ? selected.accounts.has(`${CODEX_POOL_PROVIDER}:${account.id}`) : true)
    : [];
  const omitted = selected.codex ? codexOmitted : [];
  const native = readNativeCodexLogin(deps);
  const nativeSelected = selected.native && native.status === "ok"
    && (selected.accounts ? selected.accounts.has(`${CODEX_POOL_PROVIDER}:${NATIVE_CODEX_ACCOUNT_ID}`) : true);
  const notes = [...ACCOUNT_EXPORT_OMITTED, ...omitted];
  if (selection && (selection.providers || selection.accounts)) {
    notes.push("accounts outside the requested selection were not read into this document");
  }
  if (skipped > 0) notes.push(`${skipped} OAuth account(s) without both access and refresh tokens were skipped`);
  if (native.status === "unreadable") notes.push("the native Codex login (\$CODEX_HOME/auth.json) could not be parsed and is not included");
  if (native.status === "api-key-only") notes.push("the native Codex login uses an API key, not an OAuth grant, and is not included");
  return {
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(),
    oauth,
    codex,
    ...(nativeSelected && native.status === "ok" ? { nativeCodex: native.credential } : {}),
    omitted: notes,
  };
}

/**
 * Turn a selection into the families it may read.
 *
 * `openai` addresses the Codex pool; every other name is an OAuth provider key. Naming an account
 * narrows the families too, so asking for one Claude account never even parses the Codex store.
 */
function selectionFilter(selection: AccountExportSelection | undefined): {
  oauth: boolean;
  codex: boolean;
  native: boolean;
  providers: ReadonlySet<string> | undefined;
  accounts: ReadonlySet<string> | undefined;
} {
  if (!selection || (!selection.providers && !selection.accounts)) {
    return { oauth: true, codex: true, native: true, providers: undefined, accounts: undefined };
  }
  const providers = selection.providers && selection.providers.length > 0 ? new Set(selection.providers) : undefined;
  const accounts = selection.accounts && selection.accounts.length > 0 ? new Set(selection.accounts) : undefined;
  // Providers named by an account selector are read too, so `-a claude:x` works without `-p`.
  const named = new Set<string>();
  for (const provider of providers ?? []) named.add(provider);
  for (const pair of accounts ?? []) named.add(pair.slice(0, pair.indexOf(":")));
  const wants = (name: string) => named.size === 0 || named.has(name);
  const wantsNative = wants(CODEX_POOL_PROVIDER)
    && (accounts
      ? accounts.has(`${CODEX_POOL_PROVIDER}:${NATIVE_CODEX_ACCOUNT_ID}`)
        || accounts.has(`${CODEX_POOL_PROVIDER}:__main__`)
      : true);
  return {
    oauth: [...named].some(name => name !== CODEX_POOL_PROVIDER) || named.size === 0,
    codex: wants(CODEX_POOL_PROVIDER),
    native: wantsNative,
    providers,
    accounts,
  };
}
