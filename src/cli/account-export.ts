/**
 * `ocx account export` — local-only credential export.
 *
 * This never calls the management API. Refresh tokens are the one credential a proxy cannot
 * recreate, and the dashboard/HTTP surface is reachable by any local process holding the admin
 * token; a file an operator names themselves is the narrower boundary. `--json` prints a
 * secret-free receipt so an agent transcript never contains the document.
 */
import { basename, dirname, join } from "node:path";
import { buildAccountExport, type AccountExportReadDeps } from "../oauth/account-export/read";
import { writeAccountExportFile } from "../oauth/account-export/write";
import {
  ACCOUNT_EXPORT_FORMATS,
  formatWriters,
  type FormatWriteResult,
} from "../oauth/account-export/format";
import type { AccountExportDocument, AccountExportFormat } from "../oauth/account-export/document";
import { redactSecretArgs } from "./secret-args";

export const ACCOUNT_EXPORT_USAGE = `Usage:
  ocx account export --file <path> [--provider <name>]... [--account <provider:id|alias>]... [--format <format>] [--force] [--json]
  ocx account export --stdout --yes [--provider <name>]... [--account <provider:id|alias>]... [--format <format>]

Formats:
  full                OpenCodex document (oauth + codex + nativeCodex)
  cockpit-tools       Antigravity rows accepted by ocx account import
  codex-auth          Codex CLI / Codex Switcher auth.json (one account)
  claude-credentials  Claude Code .credentials.json (one account)
  cliproxyapi         One CLIProxyAPI auth-dir file per account`;

export interface AccountExportDeps extends AccountExportReadDeps {
  writeFile?: typeof writeAccountExportFile;
}

interface ExportOptions {
  file?: string;
  stdout: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
  format: AccountExportFormat;
  providers: string[];
  accounts: string[];
}

function parseOptions(args: string[]): { ok: true; options: ExportOptions } | { ok: false; error: string } {
  const options: ExportOptions = { stdout: false, yes: false, force: false, json: false, format: "full", providers: [], accounts: [] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--stdout") {
      if (seen.has(arg)) return { ok: false, error: ACCOUNT_EXPORT_USAGE };
      seen.add(arg);
      options.stdout = true;
      continue;
    }
    if (arg === "--yes" || arg === "--force" || arg === "--json") {
      if (seen.has(arg)) return { ok: false, error: ACCOUNT_EXPORT_USAGE };
      seen.add(arg);
      if (arg === "--yes") options.yes = true;
      else if (arg === "--force") options.force = true;
      else options.json = true;
      continue;
    }
    if (arg === "--file" || arg === "--format" || arg === "--provider" || arg === "--account") {
      // Selection flags repeat: exporting two providers or two accounts at once is the normal case.
      const repeatable = arg === "--provider" || arg === "--account";
      if (!repeatable && seen.has(arg)) return { ok: false, error: ACCOUNT_EXPORT_USAGE };
      seen.add(arg);
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: ACCOUNT_EXPORT_USAGE };
      if (arg === "--file") options.file = value;
      else if (arg === "--provider") options.providers.push(value);
      else if (arg === "--account") {
        // A pair without a provider cannot be resolved, and guessing one is how the wrong
        // account gets exported.
        if (!/^[^:\s]+:\S+$/.test(value)) return { ok: false, error: "--account needs <provider>:<account-id-or-alias>" };
        options.accounts.push(value);
      } else if ((ACCOUNT_EXPORT_FORMATS as readonly string[]).includes(value)) options.format = value as AccountExportFormat;
      else return { ok: false, error: `format must be one of ${ACCOUNT_EXPORT_FORMATS.join(", ")}` };
      continue;
    }
    // Never echo an operand: a mistyped command can carry a credential, and this parser is the
    // first thing that sees it.
    const shown = redactSecretArgs([arg], true);
    return { ok: false, error: `unexpected argument: ${shown[0]}` };
  }
  if (options.stdout && options.file) return { ok: false, error: "choose --file or --stdout, not both" };
  if (!options.stdout && !options.file) return { ok: false, error: "an export path is required (use --file <path>, or --stdout --yes)" };
  if (options.stdout && !options.yes) return { ok: false, error: "--stdout prints refresh tokens; add --yes to confirm" };
  if (options.force && options.stdout) return { ok: false, error: "--force applies to --file only" };
  // Formats that name one credential cannot be combined with a multi-account selection at parse
  // time only by count; the writer still checks the actual document.
  return { ok: true, options };
}

/** Only the fields Cockpit Tools consumes: one email + Google refresh token + project id. */
export function cockpitToolsDocument(document: AccountExportDocument): Array<Record<string, string>> {
  const set = document.oauth["google-antigravity"];
  const rows: Array<Record<string, string>> = [];
  for (const account of set?.accounts ?? []) {
    const email = account.credential.email;
    const refresh = account.credential.refresh;
    // The Cockpit schema rejects a record without these; skipping beats emitting a row the
    // importer will mark invalid.
    if (typeof email !== "string" || email.length === 0 || email !== email.trim() || /[\x00-\x20\x7f]/.test(email)) continue;
    if (typeof refresh !== "string" || refresh.length === 0 || /[\s\x7f]/.test(refresh)) continue;
    rows.push({
      email: email.toLowerCase(),
      refresh_token: refresh,
      ...(account.credential.projectId ? { project_id: account.credential.projectId } : {}),
    });
  }
  return rows;
}

function sanitizedDocument(document: AccountExportDocument, format: AccountExportFormat): unknown {
  if (format === "cockpit-tools") return cockpitToolsDocument(document);
  return document;
}

interface ExportReceipt {
  ok: true;
  format: AccountExportFormat;
  version: number;
  exportedAt: string;
  oauthProviders?: number;
  oauthAccounts?: number;
  codexAccounts?: number;
  nativeCodex?: boolean;
  accounts?: number;
}

/** Counts only: no email, account id, token fragment or provider secret. */
function receipt(document: AccountExportDocument, format: AccountExportFormat): ExportReceipt {
  if (format === "cockpit-tools") {
    const rows = cockpitToolsDocument(document);
    return { ok: true, format, version: document.version, exportedAt: document.exportedAt, accounts: rows.length };
  }
  return {
    ok: true,
    format,
    version: document.version,
    exportedAt: document.exportedAt,
    oauthProviders: Object.keys(document.oauth).length,
    oauthAccounts: Object.values(document.oauth).reduce((total, set) => total + set.accounts.length, 0),
    codexAccounts: document.codex.length,
    nativeCodex: document.nativeCodex !== undefined,
  };
}

/** Human output: counts plus where the file went. Never the token values. */
function humanLines(result: ExportReceipt, path: string | null): string[] {
  const scope = result.format === "cockpit-tools"
    ? `${result.accounts} Antigravity account(s)`
    : `${result.oauthAccounts} OAuth account(s) across ${result.oauthProviders} provider(s), ${result.codexAccounts} Codex Pool account(s)${result.nativeCodex ? ", the native Codex login" : ""}`;
  const lines = [`Exported ${scope}.`];
  if (path) lines.push(`File: ${path} (owner-only permissions; it contains refresh tokens).`);
  return lines;
}

export async function cmdAccountExport(args: string[], deps: AccountExportDeps = {}): Promise<number> {
  const parsed = parseOptions(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  const { options } = parsed;
  const document = buildAccountExport({
    ...deps,
    selection: options.providers.length > 0 || options.accounts.length > 0
      ? { providers: options.providers, accounts: options.accounts }
      : undefined,
  });
  const projected = formatWriters(options.format, document);
  if (!projected.ok) {
    const message = projected.code === "format_requires_one_account"
      ? `${options.format} holds one credential; narrow the selection with --account <provider>:<id>, or use full / cliproxyapi / cockpit-tools`
      : "the selection contains no credential this format can represent";
    if (options.json) console.log(JSON.stringify({ ok: false, code: projected.code }, null, 2));
    else console.error(message);
    return 1;
  }
  if (options.stdout) {
    // stdout is one document stream: several files concatenated would not parse as JSON.
    if (projected.files.length !== 1) {
      console.error(`${options.format} produces ${projected.files.length} files; write them with --file instead of --stdout`);
      return 1;
    }
    process.stdout.write(projected.files[0]!.content);
    return 0;
  }
  const write = deps.writeFile ?? writeAccountExportFile;
  const target = options.file as string;
  // One file keeps the operator's exact path; several files land beside it under the same stem,
  // because `--file accounts.json` with CLIProxyAPI would otherwise silently keep only the last.
  const targets = projected.files.length === 1
    ? [target]
    : projected.files.map(file => join(dirname(target), `${basename(target).replace(/\.json$/i, "")}-${file.filename}`));
  const written: string[] = [];
  for (let index = 0; index < projected.files.length; index++) {
    const result = write(targets[index] as string, projected.files[index]!.content, { force: options.force });
    if (!result.ok) {
      const message = result.code === "target_exists"
        ? `target exists: ${targets[index]}; choose another path or pass --force`
        : result.code === "target_is_directory"
          ? `target is a directory: ${targets[index]}`
          : result.code === "unsafe_target"
            ? `target is a link: ${targets[index]}; choose a plain file path`
            : `export could not be written: ${targets[index]}`;
      if (options.json) console.log(JSON.stringify({ ok: false, code: result.code, path: targets[index], written }, null, 2));
      else console.error(message);
      return 1;
    }
    written.push(result.path);
  }
  const summary = receipt(document, options.format);
  if (options.json) {
    console.log(JSON.stringify({ ...summary, paths: written, ...(written.length === 1 ? { path: written[0] } : {}) }, null, 2));
  } else {
    const lines = humanLines(summary, written[0] ?? null);
    if (written.length > 1) lines.push(`Wrote ${written.length} files:`, ...written.map(path => `  ${path}`));
    console.log(lines.join("\n"));
  }
  return 0;
}
