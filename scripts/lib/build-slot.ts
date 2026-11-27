import { existsSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const DEFAULT_BUILD_SLOT_PATH = "D:\\Andrew\\Code\\tools\\build-slot.js";

export function resolveBuildSlotPath(env: Record<string, string | undefined> = process.env): string {
  return env.BUILD_SLOT_PATH !== undefined ? env.BUILD_SLOT_PATH : DEFAULT_BUILD_SLOT_PATH;
}

export function shouldUseBuildSlot(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== "win32" || env.CI) return false;
  const p = resolveBuildSlotPath(env);
  return Boolean(p) && existsSync(p);
}

export function wrapWithBuildSlot(
  queue: string,
  command: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): { command: string; args: string[]; delegated: boolean } {
  if (shouldUseBuildSlot(env, platform)) {
    const slotPath = resolveBuildSlotPath(env);
    return {
      command: "node",
      args: [slotPath, "--queue", queue || "compile", "--", command, ...args],
      delegated: true,
    };
  }
  return { command, args, delegated: false };
}

export function runWithBuildSlot(
  queue: string,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: "inherit" | "pipe";
  } = {},
): SpawnSyncReturns<string> {
  const env = options.env ?? process.env;
  const inv = wrapWithBuildSlot(queue, command, args, env, process.platform);
  return spawnSync(inv.command, inv.args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
}

if (import.meta.main) {
  const raw = Bun.argv.slice(2);
  const sep = raw.indexOf("--");
  const opts = sep >= 0 ? raw.slice(0, sep) : [];
  const cmd = sep >= 0 ? raw.slice(sep + 1) : raw;
  let queue = "compile";
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i] === "--queue") queue = opts[++i] ?? "compile";
  }
  if (cmd.length === 0) {
    console.error("Usage: bun scripts/lib/build-slot.ts [--queue <name>] -- <command> [args]");
    process.exit(2);
  }
  const res = runWithBuildSlot(queue, cmd[0]!, cmd.slice(1));
  if (res.error) {
    console.error(`build-slot wrapper failed: ${res.error.message}`);
    process.exit(127);
  }
  process.exit(res.status === null ? 1 : res.status);
}
