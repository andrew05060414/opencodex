/**
 * Account credential export dialog.
 *
 * Three decisions this surface encodes:
 *
 * 1. **Selection before format.** Accounts are ticked by credential, because "export Codex" and
 *    "export Claude" are two different files the operator keeps apart. Unticking everything means
 *    the whole store, so a first-time user does not have to learn the list to get a full backup.
 * 2. **The warning precedes the request.** Refresh tokens are long-lived, so the consequence is on
 *    screen before any byte leaves the proxy.
 * 3. **A refusal is actionable.** The automatic loopback session is refused by the server; the
 *    dialog then prints the exact CLI command for this selection, because that is how the same
 *    file is produced without a paired session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch } from "../bounded-fetch";
import { accountExportBody, accountExportFilename, downloadFile } from "../account-export-download";
import { accountExportCommand } from "../account-export-command";
import { IconDownload } from "../icons";

export type AccountExportFormat = "full" | "cockpit-tools" | "codex-auth" | "claude-credentials" | "cliproxyapi";

/** One credential the operator can tick; `key` is what the server selection accepts. */
export interface ExportAccountRow {
  key: string;
  provider: string;
  label: string;
  group: string;
}

/** Exports are small; this bound only stops a hung connection from pinning the dialog. */
const EXPORT_TIMEOUT_MS = 30_000;

export type AccountExportOutcome =
  | { ok: true; filename: string; bytes: number; files: number }
  | { ok: false; kind: "denied" | "failed" | "invalid" };

interface ExportFileBody {
  filename: string;
  content: string;
}

/** Validate the two response shapes: the full document, or `{format, files}` for other formats. */
function readExportFiles(format: AccountExportFormat, body: unknown): ExportFileBody[] | null {
  if (format === "full") {
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as { version?: unknown }).version !== 1) return null;
    return [{ filename: accountExportFilename("full"), content: accountExportBody(JSON.stringify(body, null, 2)) }];
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const out: ExportFileBody[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") return null;
    const { filename, content } = file as { filename?: unknown; content?: unknown };
    if (typeof filename !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(filename)) return null;
    if (typeof content !== "string" || content.length === 0) return null;
    out.push({ filename, content });
  }
  return out;
}

export default function AccountExportDialog({
  apiBase,
  accounts,
  onClose,
  onExported,
}: {
  apiBase: string;
  accounts?: readonly ExportAccountRow[];
  onClose: () => void;
  onExported: (outcome: AccountExportOutcome) => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<AccountExportFormat>("full");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"denied" | "failed" | "invalid" | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);

  const groups = useMemo(() => {
    const byGroup = new Map<string, ExportAccountRow[]>();
    for (const row of accounts ?? []) {
      const list = byGroup.get(row.group) ?? [];
      list.push(row);
      byGroup.set(row.group, list);
    }
    return [...byGroup.entries()];
  }, [accounts]);

  // One credential per file: these formats cannot represent a whole store, so the selection is
  // required and the confirm button stays disabled until exactly one account is ticked.
  const singleAccountFormat = format === "codex-auth" || format === "claude-credentials";
  const needsSingle = singleAccountFormat && selected.size !== 1;

  const fallbackCommand = useMemo(
    () => accountExportCommand(format, [...selected]),
    [format, selected],
  );

  const copyFallback = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(fallbackCommand);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }, [fallbackCommand]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!busy) onClose();
  }, [busy, onClose]);

  const toggle = useCallback((key: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setCopied(null);
  }, []);

  const exportDocument = useCallback(async () => {
    if (busy || needsSingle) return;
    setBusy(true);
    setError(null);
    const bounded = createBoundedFetch(EXPORT_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/oauth/accounts/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          ...(selected.size > 0 ? { selection: { accounts: [...selected] } } : {}),
        }),
        signal: bounded.signal,
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        setError("denied");
        return;
      }
      if (!response.ok) {
        setError("failed");
        return;
      }
      const files = readExportFiles(format, await response.json().catch(() => null));
      if (files === null) {
        setError("invalid");
        return;
      }
      for (const file of files) downloadFile(file.filename, file.content);
      onExported({
        ok: true,
        filename: files[0]!.filename,
        bytes: files.reduce((total, file) => total + file.content.length, 0),
        files: files.length,
      });
      onClose();
    } catch {
      setError("failed");
    } finally {
      bounded.clear();
      setBusy(false);
    }
  }, [apiBase, busy, format, needsSingle, onClose, onExported, selected]);

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby="account-export-title" onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => { if (!busy) onClose(); }} />
      <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
        <h3 id="account-export-title">{t("pws.exportTitle")}</h3>
        <p className="card-sub">{t("pws.exportWarning")}</p>

        {groups.length > 0 && (
          <fieldset className="pwi-export-accounts" disabled={busy}>
            <legend className="pwi-export-legend">
              {t("pws.exportAccounts")}
              <span className="pwi-auth-row-secondary">
                {selected.size === 0 ? t("pws.exportAllSelected") : t("pws.exportSelectedCount", { count: String(selected.size) })}
              </span>
            </legend>
            {groups.map(([group, rows]) => (
              <div key={group} className="pwi-export-group">
                <div className="pwi-export-group-head">{group}</div>
                {rows.map(row => (
                  <label key={row.key} className="pwi-export-account">
                    <input type="checkbox" checked={selected.has(row.key)} onChange={() => toggle(row.key)} disabled={busy} />
                    <span>{row.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
        )}

        <fieldset className="pwi-export-formats" disabled={busy}>
          <legend className="pwi-export-legend">{t("pws.exportFormat")}</legend>
          {EXPORT_FORMAT_KEYS.map(option => (
            <label key={option.id} className="pwi-export-option">
              <input type="radio" name="account-export-format" value={option.id}
                checked={format === option.id} onChange={() => setFormat(option.id)} />
              <span>
                <strong>{t(option.label)}</strong>
                <span className="pwi-auth-row-secondary">{t(option.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {needsSingle && (
          <p className="pwi-auth-row-secondary">{t("pws.exportSingleAccountHint")}</p>
        )}
        {error && (
          <p role="alert" className="pws-status-warn">
            {error === "denied" ? t("pws.exportDenied") : error === "invalid" ? t("pws.exportInvalid") : t("pws.exportFailed")}
          </p>
        )}
        {error === "denied" && (
          <div className="pwi-export-fallback">
            <p className="pwi-auth-row-secondary">{t("pws.exportFallbackHint")}</p>
            <code className="api-code api-code-inline">{fallbackCommand}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void copyFallback(); }}>
              {copied === "ok" ? t("pws.exportFallbackCopied") : t("pws.exportFallbackCopy")}
            </button>
            {copied === "failed" && <span className="pws-status-warn">{t("pws.exportFallbackFailed")}</span>}
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => { void exportDocument(); }} disabled={busy || needsSingle}>
            <IconDownload width={14} height={14} aria-hidden="true" />{" "}
            {busy ? t("pws.exporting") : t("pws.exportConfirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

const EXPORT_FORMAT_KEYS: ReadonlyArray<{
  id: AccountExportFormat;
  label: "pws.exportFormatFull" | "pws.exportFormatCockpit" | "pws.exportFormatCodexAuth" | "pws.exportFormatClaude" | "pws.exportFormatCliProxy";
  hint: "pws.exportFormatFullHint" | "pws.exportFormatCockpitHint" | "pws.exportFormatCodexAuthHint" | "pws.exportFormatClaudeHint" | "pws.exportFormatCliProxyHint";
}> = [
  { id: "full", label: "pws.exportFormatFull", hint: "pws.exportFormatFullHint" },
  { id: "codex-auth", label: "pws.exportFormatCodexAuth", hint: "pws.exportFormatCodexAuthHint" },
  { id: "claude-credentials", label: "pws.exportFormatClaude", hint: "pws.exportFormatClaudeHint" },
  { id: "cockpit-tools", label: "pws.exportFormatCockpit", hint: "pws.exportFormatCockpitHint" },
  { id: "cliproxyapi", label: "pws.exportFormatCliProxy", hint: "pws.exportFormatCliProxyHint" },
];
