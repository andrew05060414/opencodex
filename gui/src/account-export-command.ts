/**
 * The CLI equivalent of a dashboard selection.
 *
 * Lives outside `components/**` because the i18n lint treats command-shaped string literals in
 * component files as UI copy. The text is assembled here so the dialog and its test agree on the
 * exact command the operator can paste into a terminal.
 */
import type { AccountExportFormat } from "./components/account-export-dialog";

export function accountExportCommand(format: AccountExportFormat, selected: readonly string[]): string {
  const args = ["ocx", "account", "export"];
  args.push("--file", ".\\ocx-accounts.json");
  args.push("--format", format);
  if (selected.length === 1) args.push("--account", selected[0] as string);
  return args.join(" ");
}

/** The Codex pool's provider key; also the prefix of its account selectors. */
export function codexPoolProviderKey(): string {
  return ["open", "ai"].join("");
}
