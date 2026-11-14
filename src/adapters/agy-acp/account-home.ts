import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/paths";

export interface AgyAccountRef {
  id: string;
  credential: { access: string; refresh: string; expires: number; email?: string };
}

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function agyAccountHome(accountId: string, configDir: string = getConfigDir()): string {
  if (!SAFE_ACCOUNT_ID.test(accountId)) throw new Error("agy account id is not a safe directory name");
  return join(configDir, "agy-homes", accountId);
}

export function agyTokenFilePath(home: string): string {
  return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

interface ExistingTokenFile {
  refreshToken?: string;
  expiresMs?: number;
  writerId?: string;
}

function parseExisting(text: string): ExistingTokenFile {
  const parsed = JSON.parse(text) as {
    token?: { refresh_token?: unknown; expiry?: unknown };
    writer_id?: unknown;
  };
  const expiry = typeof parsed.token?.expiry === "string" ? Date.parse(parsed.token.expiry) : Number.NaN;
  return {
    refreshToken: typeof parsed.token?.refresh_token === "string" ? parsed.token.refresh_token : undefined,
    expiresMs: Number.isFinite(expiry) ? expiry : undefined,
    writerId: typeof parsed.writer_id === "string" ? parsed.writer_id : undefined,
  };
}

async function readExisting(path: string): Promise<ExistingTokenFile | undefined> {
  try {
    return parseExisting(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Write the agy token file for one account when it is missing, belongs to another refresh
 * grant, or carries an older expiry than OCX's credential. A file that agy refreshed itself
 * has a later expiry, so it is left alone. Token values are never logged or thrown.
 */
export async function ensureAgyTokenFile(account: AgyAccountRef, home: string, now = Date.now()): Promise<"written" | "current"> {
  const path = agyTokenFilePath(home);
  const existing = await readExisting(path);
  const current = existing !== undefined
    && existing.refreshToken === account.credential.refresh
    && existing.expiresMs !== undefined
    && account.credential.expires <= existing.expiresMs;
  if (current) return "current";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const writerId = existing?.writerId ?? randomBytes(32).toString("base64url");
  const expiresMs = account.credential.expires;
  const body = JSON.stringify({
    token: {
      access_token: account.credential.access,
      token_type: "Bearer",
      refresh_token: account.credential.refresh,
      expiry: new Date(expiresMs).toISOString(),
      expires_in: Math.max(0, Math.round((expiresMs - now) / 1000)),
    },
    auth_method: "consumer",
    id_token_email: account.credential.email ?? "",
    writer_id: writerId,
  });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, path);
  return "written";
}
