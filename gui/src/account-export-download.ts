/**
 * Browser download helpers for a credential export.
 *
 * Kept out of `components/**` because the i18n lint treats string literals there as UI copy;
 * these values are filenames and media types. Every download is triggered from a user gesture
 * (the dialog's button), which is what lets several files be saved in one turn.
 */
import type { AccountExportFormat } from "./components/account-export-dialog";

export const ACCOUNT_EXPORT_MEDIA_TYPE = "application/json";

export function accountExportFilename(format: AccountExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  const base = format === "cockpit-tools" ? "antigravity" : format === "full" ? "ocx-accounts" : format;
  return `${base}-${stamp}.json`;
}

/** Serialized document bytes for the download blob; newline-terminated like an on-disk file. */
export function accountExportBody(json: string): string {
  return `${json}\n`;
}

export function downloadFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: ACCOUNT_EXPORT_MEDIA_TYPE }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
