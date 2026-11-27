import {
  KEYCHAIN_REFERENCE_PREFIX,
  invalidateResolvedProviderKeyCache,
  isKeychainReference,
  keychainAccount,
  providerKeychainEntry,
} from "./api-key-resolve";
import type { OcxProviderConfig } from "../types";

export interface ProviderKeychainRenameMove {
  fromAccount: string;
  toAccount: string;
  /** True only when this rename created the destination item; rollback may delete only those. */
  copied: boolean;
}

function ownedSuffix(account: string, from: string): string | undefined {
  if (account === from) return "";
  if (account.startsWith(`${from}/`)) return account.slice(from.length);
  return undefined;
}

function rewrittenReference(value: string | undefined, from: string, to: string): string | undefined {
  if (!isKeychainReference(value)) return value;
  const suffix = ownedSuffix(keychainAccount(value), from);
  if (suffix === undefined) return value;
  return `${KEYCHAIN_REFERENCE_PREFIX}${to}${suffix}`;
}

function readAccount(account: string): string | null {
  try {
    return providerKeychainEntry(account).getPassword();
  } catch {
    throw new Error("provider_keychain_unavailable");
  }
}

function recordMove(moves: ProviderKeychainRenameMove[], fromAccount: string, toAccount: string, copied: boolean): void {
  const existing = moves.find(move => move.fromAccount === fromAccount && move.toAccount === toAccount);
  if (existing) existing.copied ||= copied;
  else moves.push({ fromAccount, toAccount, copied });
}

/**
 * Copy owned `keychain:<from>` accounts to the renamed provider's account namespace and rewrite
 * the provider row's references. Copies are idempotent because the durable config mutation may
 * re-run this function while rebasing; deletion of the old accounts is deliberately left to
 * `completeProviderKeychainRename` after the config commit.
 */
export function migrateProviderKeychainReferencesForRename(
  provider: OcxProviderConfig,
  from: string,
  to: string,
  moves: ProviderKeychainRenameMove[],
): void {
  const refs = [provider.apiKey, ...(provider.apiKeyPool ?? []).map(entry => entry.key)];
  const planned = new Map<string, string>();
  for (const ref of refs) {
    if (!isKeychainReference(ref)) continue;
    const fromAccount = keychainAccount(ref);
    const suffix = ownedSuffix(fromAccount, from);
    if (suffix !== undefined) planned.set(fromAccount, `${to}${suffix}`);
  }

  for (const [fromAccount, toAccount] of planned) {
    const secret = readAccount(fromAccount);
    const existing = readAccount(toAccount);
    let copied = false;
    if (typeof secret === "string") {
      if (existing !== null && existing !== secret) throw new Error("provider_keychain_destination_conflict");
      if (existing !== secret) {
        try {
          const entry = providerKeychainEntry(toAccount);
          entry.setPassword(secret);
          if (entry.getPassword() !== secret) throw new Error("read-back mismatch");
        } catch {
          throw new Error("provider_keychain_write_failed");
        }
        copied = true;
      }
    } else if (existing !== null) {
      // A destination secret whose source cannot be proven is not safe to adopt: it may belong
      // to an unrelated provider created after an earlier partial rename.
      throw new Error("provider_keychain_destination_conflict");
    }
    recordMove(moves, fromAccount, toAccount, copied);
  }

  provider.apiKey = rewrittenReference(provider.apiKey, from, to);
  for (const entry of provider.apiKeyPool ?? []) {
    entry.key = rewrittenReference(entry.key, from, to)!;
  }
}

/** Roll back destination items this rename created when the durable config mutation does not commit. */
export function rollbackProviderKeychainRename(moves: ProviderKeychainRenameMove[]): void {
  const accounts = new Set(moves.filter(move => move.copied).map(move => move.toAccount));
  for (const account of accounts) {
    try { providerKeychainEntry(account).deletePassword(); } catch { /* best effort */ }
  }
  if (accounts.size > 0) invalidateResolvedProviderKeyCache();
}

/** Remove source accounts after the renamed references are durable. Deletion is best-effort by design. */
export function completeProviderKeychainRename(moves: ProviderKeychainRenameMove[]): void {
  const accounts = new Set(moves.map(move => move.fromAccount));
  for (const account of accounts) {
    try { providerKeychainEntry(account).deletePassword(); } catch { /* best effort */ }
  }
  if (accounts.size > 0) invalidateResolvedProviderKeyCache();
}
