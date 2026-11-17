import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAccountLease, type AccountLease } from "../../../src/oauth/kiro-account-load";
import { clearPoolRotationState } from "../../../src/oauth/pool-kernel";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { ProviderAccount } from "../../../src/oauth/types";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import {
  clearGenericFailoverHealth, noteGenericPoolSelection, preferredInitialAccount,
  refusalAwareInitialKiroAccount, rotateGenericOAuthAccountOn429,
} from "../../../src/oauth/generic-account-failover";
import { awaitKiroModelRefreshForTests, clearKiroAccountModels,
  refreshKiroAccountModelsDetached } from "../../../src/providers/kiro-model-catalog";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalSwitch = process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
let home: string | undefined;
let leases: AccountLease[] = [];
const provider = { baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", adapter: "kiro" } as OcxProviderConfig;

function setup(): void {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-preference-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "1";
  clearKiroAccountModels();
  clearGenericFailoverHealth("kiro");
  clearPoolRotationState();
}

afterEach(() => {
  for (const lease of leases) lease.release();
  leases = [];
  clearKiroAccountModels();
  clearGenericFailoverHealth("kiro");
  clearPoolRotationState();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalSwitch === undefined) delete process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
  else process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = originalSwitch;
  if (home) removeTreeWithRetry(home);
  home = undefined;
});

async function add(label: string): Promise<ProviderAccount> {
  await saveCredential("kiro", { access: `access-${label}`, refresh: `refresh-${label}`,
    expires: Date.now() + 3_600_000, accountId: label,
    kiro: { profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${label}` } },
  { addAccount: true });
  return getAccountSet("kiro")!.accounts.find(row => row.credential.accountId === label)!;
}

async function prime(account: ProviderAccount, models: string[]): Promise<void> {
  refreshKiroAccountModelsDetached(account, provider, {
    resolveAddresses: async (url: string) => ({ hostname: new URL(url).hostname,
      addresses: [{ address: "1.1.1.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async () => new Response(JSON.stringify({ models: models.map(modelId => ({ modelId })) })),
  } as never);
  await awaitKiroModelRefreshForTests(account.id);
}

function config(strategy: string, cap?: number, enabled = true): OcxConfig {
  return { pool: { kernel: true }, providers: { kiro: { ...provider,
    oauthAccountFailover: { enabled, strategy,
      ...(cap !== undefined ? { maxConcurrentPerAccount: cap } : {}) } } } } as OcxConfig;
}

test("fill-first leaves a healthy active account that lacks the model for a sibling that lists it", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(preferredInitialAccount(config("fill-first"), "kiro", Date.now(), "wanted")).toBe(b.id);
});

test("refusal-aware first admission prefers a sibling that lists the model", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(refusalAwareInitialKiroAccount(config("quota"), a.id, Date.now(), "wanted")).toBe(b.id);
});

test("no catalogue evidence never moves a healthy active account", async () => {
  setup();
  const a = await add("a");
  await add("b");
  await setActiveAccount("kiro", a.id);
  expect(preferredInitialAccount(config("fill-first"), "kiro", Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota"), a.id, Date.now(), "wanted")).toBeNull();
});

test("a listing sibling at its cap does not displace an active account with room", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  leases.push((await acquireAccountLease("kiro", b.id))!);
  expect(preferredInitialAccount(config("fill-first", 1), "kiro", Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota", 1), a.id, Date.now(), "wanted")).toBeNull();
});

test("reactive Kiro rotation prefers model evidence after room filtering", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  const c = await add("c");
  await prime(b, ["other"]);
  await prime(c, ["wanted"]);
  expect(rotateGenericOAuthAccountOn429(config("quota"), "kiro", a.id, null,
    Date.now(), "wanted")).toBe(c.id);
});

test("positive membership outranks lower load for proactive least-loaded choice", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  leases.push((await acquireAccountLease("kiro", b.id))!);
  expect(preferredInitialAccount(config("least-loaded"), "kiro", Date.now(), "wanted")).toBe(b.id);
});

test("explicit proactive off keeps the healthy active account despite model evidence", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(preferredInitialAccount(config("fill-first", undefined, false), "kiro",
    Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota", undefined, false), a.id,
    Date.now(), "wanted")).toBeNull();
});

/**
 * One admission the way the transport does it: propose, take the lease, then commit the pick.
 * The lease is held while the selection is noted, so the admitted account counts toward its own cap.
 */
async function admitRoundRobin(cfg: OcxConfig, model: string): Promise<string> {
  const active = getAccountSet("kiro")!.activeAccountId!;
  const admitted = preferredInitialAccount(cfg, "kiro", Date.now(), model) ?? active;
  const lease = await acquireAccountLease("kiro", admitted, {
    maxConcurrentPerAccount: cfg.providers.kiro!.oauthAccountFailover!.maxConcurrentPerAccount });
  expect(lease).not.toBeNull();
  noteGenericPoolSelection(cfg, "kiro", admitted, model);
  await setActiveAccount("kiro", admitted);
  lease!.release();
  return admitted;
}

test("round-robin keeps rotating under a per-account cap when the model is positively listed", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  const c = await add("c");
  await setActiveAccount("kiro", a.id);
  for (const account of [a, b, c]) await prime(account, ["wanted"]);
  const cfg = config("round-robin", 1);
  cfg.providers.kiro!.oauthAccountFailover!.stickyLimit = 1;
  const order: string[] = [];
  for (let turn = 0; turn < 6; turn += 1) order.push(await admitRoundRobin(cfg, "wanted"));
  expect(order.slice(0, 3).sort()).toEqual([a.id, b.id, c.id].sort());
  expect(order.slice(3)).toEqual(order.slice(0, 3));
});

test("round-robin rotation without a cap is unchanged by the same flow", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  const c = await add("c");
  await setActiveAccount("kiro", a.id);
  for (const account of [a, b, c]) await prime(account, ["wanted"]);
  const cfg = config("round-robin");
  cfg.providers.kiro!.oauthAccountFailover!.stickyLimit = 1;
  const order: string[] = [];
  for (let turn = 0; turn < 6; turn += 1) order.push(await admitRoundRobin(cfg, "wanted"));
  expect(order.slice(0, 3).sort()).toEqual([a.id, b.id, c.id].sort());
  expect(order.slice(3)).toEqual(order.slice(0, 3));
});
