import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";

export interface AgyBridge {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  shutdown(): Promise<void>;
}

export interface AgyBridgeOptions {
  env: Record<string, string>;
  home: string;
  stateFile: string;
  agyPath?: string;
}

export type AgyBridgeFactory = (options: AgyBridgeOptions) => AgyBridge | Promise<AgyBridge>;

/** The vendored bridge loads only when the first agy request is served. */
export const loadVendoredAgyBridge: AgyBridgeFactory = async options => {
  const vendor = await import("./vendor/index.mjs");
  return vendor.createAgyBridge(options);
};

const CHILD_ENV_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "LANG", "LC_ALL"] as const;
const SSH_CONNECTION = "opencodex-agy 0 127.0.0.1 0";

/** agy keeps tokens in a file when SSH_CONNECTION is set, so each account gets its own HOME. */
export function agyChildEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, SSH_CONNECTION };
}

export interface AgyBridgePool {
  bridgeFor(accountId: string, home: string, agyPath?: string): Promise<AgyBridge>;
  shutdown(): Promise<void>;
}

export function createAgyBridgePool(factory: AgyBridgeFactory): AgyBridgePool {
  const bridges = new Map<string, Promise<AgyBridge>>();
  return {
    bridgeFor(accountId, home, agyPath) {
      const key = `${accountId}\0${agyPath ?? ""}`;
      const existing = bridges.get(key);
      if (existing) return existing;
      const created = Promise.resolve(factory({
        env: agyChildEnv(home),
        home,
        stateFile: `${home}/bridge-state.json`,
        ...(agyPath !== undefined ? { agyPath } : {}),
      }));
      bridges.set(key, created);
      created.catch(() => { if (bridges.get(key) === created) bridges.delete(key); });
      return created;
    },
    async shutdown() {
      const pending = [...bridges.values()];
      bridges.clear();
      await Promise.allSettled(pending.map(async bridge => (await bridge).shutdown()));
    },
  };
}

let defaultPool: AgyBridgePool | undefined;

export function defaultAgyBridgePool(): AgyBridgePool {
  if (!defaultPool) {
    const pool = createAgyBridgePool(loadVendoredAgyBridge);
    defaultPool = pool;
    registerOptionalShutdownHook("agy-acp-bridges", () => { void pool.shutdown().catch(() => {}); });
  }
  return defaultPool;
}
