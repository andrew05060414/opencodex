/**
 * Owner-only publication of an account export file.
 *
 * `--json` receipts never carry credentials, and a refusal (existing target, directory, link)
 * happens before any byte is written, so a typo cannot clobber a real backup.
 */
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ExportWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: "target_exists" | "target_is_directory" | "unsafe_target" | "write_failed" };

export interface ExportWriteOptions {
  /** Replace an existing file. Off by default so an export cannot silently destroy a backup. */
  force?: boolean;
  /** Test seam. */
  exists?: (path: string) => boolean;
  lstat?: typeof lstatSync;
  /** Test seam for the temp name; production derives it from pid and time. */
  tempName?: (target: string) => string;
}

function refusal(path: string, code: Exclude<ExportWriteResult, { ok: true }>["code"]): ExportWriteResult {
  return { ok: false, code };
}

/**
 * Write `content` to `path` with owner-only permissions.
 *
 * The document goes to an exclusive temp file in the destination directory and is renamed into
 * place, so a crash or a full disk leaves the previous backup intact instead of a truncated
 * credential file. The rename is also the only step that can replace an existing export, and
 * only when `force` asked for it. A Windows directory is rejected up front because renaming onto
 * one fails with an error that would otherwise be indistinguishable from a real write failure.
 */
export function writeAccountExportFile(
  path: string,
  content: string,
  options: ExportWriteOptions = {},
): ExportWriteResult {
  const target = resolve(path);
  const exists = options.exists ?? existsSync;
  const lstat = options.lstat ?? lstatSync;
  let temp: string | undefined;
  let replacing = false;
  try {
    const parent = dirname(target);
    if (!exists(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (exists(target)) {
      const stat = lstat(target);
      if (stat.isDirectory()) return refusal(target, "target_is_directory");
      if (stat.isSymbolicLink()) return refusal(target, "unsafe_target");
      if (!options.force) return refusal(target, "target_exists");
      replacing = true;
    }
    temp = options.tempName
      ? options.tempName(target)
      : join(parent, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch {
      // Creating the temp failed, so this path cannot be a partial write of the target.
      return exists(target) && !options.force ? refusal(target, "target_exists") : refusal(target, "write_failed");
    }
    try {
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      writeFileSync(fd, content, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
    // Windows refuses a rename onto an existing file, so the replacement is explicit. The temp
    // already holds every byte, so the gap cannot produce a half-written export.
    if (replacing) unlinkSync(target);
    renameSync(temp, target);
    temp = undefined;
    return { ok: true, path: target };
  } catch {
    return refusal(target, "write_failed");
  } finally {
    if (temp !== undefined) {
      try { unlinkSync(temp); } catch { /* the removal is best effort; the export was refused */ }
    }
  }
}
