/**
 * Dashboard credential export.
 *
 * The only bearer-enabled surface that returns refresh tokens. Two gates apply, and both must
 * hold at request time AND again after the body is read, because a session can be revoked while
 * a response is in flight:
 *
 * 1. A live GUI session (`sessionControl.canRevealDataKeys`). The admin token, a CLI capability
 *    principal, and an expired session are all refused — the same boundary `/api/keys/reveal`
 *    already establishes for stored data keys.
 * 2. Not an automatic loopback bootstrap. A page that merely loads the dashboard mints a loopback
 *    session; letting that session export would hand every refresh token to any script running in
 *    the dashboard origin. Pairing and trusted Tailscale identity carry an operator presence, so
 *    they are the issuances this route accepts.
 *
 * This exports the same document the CLI writes (`buildAccountExport`), so both surfaces cannot
 * drift into different field sets.
 */
import { buildAccountExport } from "../../oauth/account-export/read";
import { ACCOUNT_EXPORT_FORMATS } from "../../oauth/account-export/format";
import type { AccountExportFormat, AccountExportSelection } from "../../oauth/account-export/document";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export const ACCOUNT_EXPORT_PATH = "/api/oauth/accounts/export";

/** Max accounts one request may name; the dashboard checkbox list is far below this. */
const MAX_SELECTED_ACCOUNTS = 200;
const MAX_BODY_BYTES = 16 * 1024;

interface ExportRequest {
  format: AccountExportFormat;
  selection?: AccountExportSelection;
}

function parseRequest(value: unknown): ExportRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as { format?: unknown; selection?: unknown };
  const keys = Object.keys(body);
  if (keys.some(key => key !== "format" && key !== "selection")) return null;
  if (typeof body.format !== "string" || !(ACCOUNT_EXPORT_FORMATS as readonly string[]).includes(body.format)) return null;
  const format = body.format as AccountExportFormat;
  if (body.selection === undefined) return { format };
  const selection = body.selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;
  const { providers, accounts } = selection as { providers?: unknown; accounts?: unknown };
  const readList = (list: unknown): string[] | undefined | null => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.length > MAX_SELECTED_ACCOUNTS) return null;
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || item.length === 0 || item.length > 200 || /[\x00-\x20\x7f]/.test(item)) return null;
      out.push(item);
    }
    return out;
  };
  const parsedProviders = readList(providers);
  const parsedAccounts = readList(accounts);
  if (parsedProviders === null || parsedAccounts === null) return null;
  if (parsedProviders === undefined && parsedAccounts === undefined) return { format };
  return { format, selection: { ...(parsedProviders ? { providers: parsedProviders } : {}), ...(parsedAccounts ? { accounts: parsedAccounts } : {}) } };
}

/** Cache must never hold a document containing refresh tokens. */
function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function handleAccountExportRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== ACCOUNT_EXPORT_PATH || ctx.req.method !== "POST") return null;
  const { req, config } = ctx;
  if (ctx.principal !== "gui-session") {
    return jsonResponse({ error: "dashboard session required" }, 403, req, config);
  }
  // Automatic loopback bootstrap is enough to render the dashboard, not to disclose a grant that
  // survives this process. Deliberately stricter than `/api/keys/reveal` for that reason.
  const authorized = () => ctx.sessionControl?.canRevealDataKeys?.(req, config) === true
    && ctx.guiSessionIssuance !== "loopback";
  const denied = () => jsonResponse({
    error: "operator-authorized dashboard session required",
    code: "export_session_required",
  }, 403, req, config);
  if (!authorized()) return denied();

  // Bound the request: this endpoint ignores its body, but an unbounded read would let a caller
  // stream gigabytes into the HTTP parser before the route answers.
  if (req.headers.get("content-length") && Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
    return jsonResponse({ error: "body not accepted" }, 413, req, config);
  }
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error: "invalid body" }, 400, req, config);
  }
  // Body reception can outlive the session; do not trust the earlier admission.
  if (!authorized()) return denied();

  const parsed = parseRequest(body);
  if (!parsed) return jsonResponse({ error: "invalid body" }, 400, req, config);

  const document = buildAccountExport(parsed.selection ? { selection: parsed.selection } : {});
  if (parsed.format === "full") return noStore(jsonResponse(document, 200, req, config));
  // The other formats are file-shaped; answer with the same documents the CLI would write so
  // the dashboard download and the terminal are the same bytes.
  const { formatWriters } = await import("../../oauth/account-export/format");
  const projected = formatWriters(parsed.format, document);
  if (!projected.ok) return jsonResponse({ error: projected.code }, 422, req, config);
  return noStore(jsonResponse({ format: parsed.format, files: projected.files }, 200, req, config));
}
