import { realpathSync } from "node:fs";
import * as path from "node:path";
import { getConfigDir } from "../config/paths";
import { readBoundedRegularFileSync } from "./bounded-file-read";

/**
 * File-backed `gcp-sa:` accounts: `gcp-sa:file:<absolute path to a credential .json>`.
 *
 * A service-account JSON is ~2.4 KB, past the Windows Credential Manager blob limit (2560 bytes
 * of UTF-16LE), so pasting one into the OS store fails on Windows. A file account references the
 * JSON where it already lives instead of copying it: config.json keeps only the reference, and the
 * secret is never duplicated. The file is read only from an allowed root — the
 * `$OPENCODEX_HOME/gcp-credentials` directory, plus any directory listed in
 * `OPENCODEX_GCP_CREDENTIAL_DIRS` (path-delimiter separated) — after resolving symlinks, so a
 * config edit cannot aim the reader at an arbitrary file. Nothing in opencodex ever writes or
 * deletes a referenced file: cleanup paths only touch OS-store accounts.
 */
export const GCP_CREDENTIAL_FILE_ACCOUNT_PREFIX = "file:";
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export function isGcpCredentialFileAccount(account: string | undefined): account is string {
  return typeof account === "string" && account.startsWith(GCP_CREDENTIAL_FILE_ACCOUNT_PREFIX);
}

/** Directories a file account may resolve into, each canonicalized; missing ones are skipped. */
export function gcpCredentialFileRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.OPENCODEX_GCP_CREDENTIAL_DIRS ?? "").split(path.delimiter).map(entry => entry.trim()).filter(Boolean);
  const roots: string[] = [];
  for (const candidate of [path.join(getConfigDir(), "gcp-credentials"), ...configured]) {
    if (!path.isAbsolute(candidate)) continue;
    try { roots.push(realpathSync(candidate)); } catch { /* absent root: nothing can live there */ }
  }
  return roots;
}

function isInside(root: string, target: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(fold(root), fold(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Canonical path for a file account, or an error message. Requires an absolute `.json` path with
 * no `..` segment, then checks the symlink-resolved file against the canonical allowed roots.
 */
export function resolveGcpCredentialFilePath(account: string, env: NodeJS.ProcessEnv = process.env): { path: string } | { error: string } {
  if (!isGcpCredentialFileAccount(account)) return { error: "not a file credential account" };
  const raw = account.slice(GCP_CREDENTIAL_FILE_ACCOUNT_PREFIX.length).trim();
  if (!raw || !path.isAbsolute(raw)) return { error: "GCP credential file must be an absolute path" };
  if (raw.split(/[\\/]+/).includes("..")) return { error: "GCP credential file path must not contain '..'" };
  if (path.extname(raw).toLowerCase() !== ".json") return { error: "GCP credential file must be a .json file" };
  let real: string;
  try { real = realpathSync(path.normalize(raw)); } catch { return { error: "GCP credential file could not be found" }; }
  if (!gcpCredentialFileRoots(env).some(root => isInside(root, real))) {
    return { error: "GCP credential file is outside the allowed directories ($OPENCODEX_HOME/gcp-credentials or OPENCODEX_GCP_CREDENTIAL_DIRS)" };
  }
  return { path: real };
}

/** The raw JSON text of a file account, or undefined when it is unreadable or out of bounds. */
export function readGcpCredentialFile(account: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolved = resolveGcpCredentialFilePath(account, env);
  if ("error" in resolved) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readBoundedRegularFileSync(resolved.path, MAX_CREDENTIAL_FILE_BYTES));
  } catch {
    return undefined;
  }
}
