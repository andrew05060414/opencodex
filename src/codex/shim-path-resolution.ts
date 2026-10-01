import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * A PATH entry that reaches Windows through WSL drive interop
 * (`<automount-root>/<drive>/...`; root defaults to /mnt, configurable via
 * /etc/wsl.conf [automount] root).
 */
export function isWindowsInteropDir(dir: string, automountRoot = "/mnt"): boolean {
  const root = automountRoot.replace(/\/+$/, "");
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/[a-z](/|$)`, "i").test(dir);
}

export type CodexPathScanDeps = {
  pathValue?: string;
  wsl?: boolean;
  /** Treat PATH entries as POSIX paths (WSL context). Defaults to wsl || non-win32. */
  posixPaths?: boolean;
  automountRoot?: string;
  exists?: (path: string) => boolean;
  isShimFile?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  realpath?: (path: string) => string;
};

export function realIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return true; // unreadable -> treat as unusable
  }
}

/** The shell-local bin directory that fnm creates for one interactive shell. */
export function isFnmMultishellPath(path: string, posixPaths: boolean): boolean {
  const normalized = (posixPaths
    ? posix.normalize(path)
    : win32.normalize(path).replace(/\\/g, "/")).toLowerCase();
  return /(?:^|\/)fnm_multishells?(?:\/|$)/.test(normalized);
}

/**
 * Resolve a Codex command discovered through fnm's temporary PATH entry.
 *
 * A temporary path is safe to use only when its physical target is outside the
 * temporary tree. Returning null is deliberate: callers must not wrap the
 * shell-local path or silently choose a lower-priority Codex installation.
 */
export function resolveStableFnmCodexPath(
  path: string,
  posixPaths: boolean,
  realpath: ((path: string) => string) | undefined = realpathSync.native,
): string | null {
  if (!isFnmMultishellPath(path, posixPaths)) return path;
  try {
    const resolved = realpath(path);
    const pathTools = posixPaths ? posix : win32;
    if (!resolved || isFnmMultishellPath(resolved, posixPaths) || !pathTools.isAbsolute(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}
