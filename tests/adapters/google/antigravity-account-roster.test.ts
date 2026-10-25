import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherRoutedModels as gatherRoutedModelsDirect } from "../../../src/codex/catalog";
import { clearModelCache } from "../../../src/codex/model-cache";
import {
  antigravityModelUnlistedMessage,
  antigravityModelRefusal,
  antigravityReplacementUnavailableMessage,
  antigravitySelectedAccountUnlistedMessage,
  clearGenericFailoverHealth,
  hasEligibleGenericOAuthFailoverTarget,
  noteGenericPoolSelection,
  preferKiroModelSupport,
  preferredInitialAccount,
  rotateAntigravityAccountOnAuthRefusal,
  rotateAntigravityAccountOnModelNotFound,
  rotateGenericOAuthAccountOn429,
  routeAntigravityModel,
} from "../../../src/oauth/generic-account-failover";
import { clearPoolRotationState } from "../../../src/oauth/pool-kernel";
import {
  ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS,
  ANTIGRAVITY_MODEL_DENIAL_TTL_MS,
  antigravityAccountRosterModelIds,
  antigravityAccountSupportsModel,
  clearAntigravityAccountRosters,
  recordAntigravityAccountRoster,
  recordAntigravityModelDenial,
} from "../../../src/providers/antigravity-account-roster";
import { isAntigravityModelNotFoundRefusal } from "../../../src/server/responses/antigravity-validation-refusal";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_EFFORTS,
  parseAntigravityAvailableModels,
  resolveAntigravityEffortWireModel,
} from "../../../src/providers/antigravity-models";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

// Measured 2026-10-14 on live CCA: Antigravity gates Claude per account. One account lists only
// claude-sonnet-4-6 / claude-opus-4-6-thinking (every claude-*-5-5-* id answers 404), others list
// only the 5.5 suffix families. These payloads mirror those two roster shapes.
const PROVIDER = "google-antigravity";
const row = (maxTokens: number) => ({ maxTokens, supportsImages: true, supportsThinking: true });
const ROSTER_46 = {
  models: {
    "gemini-3.8-flash-low": row(1_048_576), "gemini-3.8-flash-medium": row(1_048_576), "gemini-3.8-flash-high": row(1_048_576),
    "claude-sonnet-4-6": row(250_000), "claude-opus-4-6-thinking": row(250_000),
  },
  agentModelSorts: [{ groups: [{ modelIds: [
    "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  ] }] }],
};
const tiers = (base: string) => ["low", "medium", "high"].map(tier => `${base}-${tier}`);
const ROSTER_55 = {
  models: Object.fromEntries([
    ...tiers("gemini-3.8-flash").map(id => [id, row(1_048_576)]),
    ...tiers("gemini-4-argon").map(id => [id, row(1_048_576)]),
    ...tiers("claude-opus-5-5").map(id => [id, row(1_000_000)]),
    ...tiers("claude-sonnet-5-5").map(id => [id, row(1_000_000)]),
  ]),
  agentModelSorts: [{ groups: [{ modelIds: [
    ...tiers("gemini-3.8-flash"), ...tiers("gemini-4-argon"), ...tiers("claude-opus-5-5"), ...tiers("claude-sonnet-5-5"),
  ] }] }],
};

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  clearAntigravityAccountRosters();
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

function homeWithAccounts(accountIds: string[], activeAccountId: string, paused: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-agy-roster-"));
  homes.push(home);
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    [PROVIDER]: {
      activeAccountId,
      accounts: accountIds.map(id => ({
        id,
        ...(paused.includes(id) ? { paused: true } : {}),
        credential: { access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000, projectId: "project-id" },
      })),
    },
  }));
  return home;
}

function provider(extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    authMode: "oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    googleMode: "cloud-code-assist",
    project: "configured-project",
    liveModels: true,
    // The static lineup, as the registry seeds it.
    models: [...ANTIGRAVITY_MODELS],
    modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
    ...extra,
  } as OcxProviderConfig;
}

async function discoveredIds(payload: unknown, accountId: string): Promise<string[]> {
  homeWithAccounts([accountId], accountId);
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  const models = await gatherRoutedModels({ providers: { [PROVIDER]: provider() } } as unknown as OcxConfig);
  return models.filter(model => model.provider === PROVIDER).map(model => model.id).sort();
}

describe("Antigravity exposure follows each account's own discovery", () => {
  test("a Claude 4.6 account exposes 4.6 and hides the static 5.5 and Argon rows", async () => {
    const ids = await discoveredIds(ROSTER_46, "acct-46");
    expect(ids).toEqual(["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.8-flash"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-sonnet-4-6")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "gemini-4-argon")).toBe(false);
  });

  test("a Claude 5.5 account exposes the full 3.8 / 4 / 5.5 / 5.5 lineup and no 4.6 row", async () => {
    const ids = await discoveredIds(ROSTER_55, "acct-55");
    expect(ids).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gemini-4-argon"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5-high")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-sonnet-4-6")).toBe(false);
    expect(antigravityAccountRosterModelIds(PROVIDER, "acct-55")).toEqual(expect.arrayContaining(["claude-opus-5-5", "gemini-4-argon"]));
  });

  test("disabled placeholder wire models (gemini-4-argon-disabled) are excluded from discovery and rosters", async () => {
    const roster46WithDisabledArgon = {
      models: {
        ...ROSTER_46.models,
        "gemini-4-argon-disabled": { displayName: "Gemini 4 Argon", disabled: true, tagTitle: "Unavailable", maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: [
        "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
        "gemini-4-argon-disabled", "claude-sonnet-4-6", "claude-opus-4-6-thinking",
      ] }] }],
    };
    const ids = await discoveredIds(roster46WithDisabledArgon, "acct-46-disabled");
    expect(ids).toEqual(["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.8-flash"]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46-disabled", "gemini-4-argon")).toBe(false);
  });

  test("multi-account discovery unions models across 4.6 and 5.5 accounts while recording per-account rosters", async () => {
    homeWithAccounts(["acct-46", "acct-55"], "acct-46");
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      return Response.json(auth === "Bearer access-acct-46" ? ROSTER_46 : ROSTER_55);
    }) as typeof fetch;
    const models = await gatherRoutedModels({ providers: { [PROVIDER]: provider() } } as unknown as OcxConfig);
    const ids = models.filter(model => model.provider === PROVIDER).map(model => model.id).sort();
    expect(ids).toEqual([
      "claude-opus-4-6-thinking",
      "claude-opus-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5-5",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-4-6-thinking")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "gemini-4-argon")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "gemini-4-argon")).toBe(true);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-4-6-thinking")).toBe(false);
  });
});

describe("Claude 4.6 and 5.5 both map", () => {
  test("4.6 rides thinkingLevel on its single wire id", () => {
    expect(ANTIGRAVITY_MODEL_EFFORTS["claude-sonnet-4-6"]).toEqual(["low", "medium", "high", "max"]);
    expect(resolveAntigravityEffortWireModel("claude-sonnet-4-6", "high"))
      .toEqual({ wireModelId: "claude-sonnet-4-6", thinkingLevel: "high" });
    // CCA's ThinkingLevel enum tops out at high.
    expect(resolveAntigravityEffortWireModel("claude-opus-4-6-thinking", "max"))
      .toEqual({ wireModelId: "claude-opus-4-6-thinking", thinkingLevel: "high" });
  });

  test("5.5 rides its per-tier suffix wire ids, statically and from discovery", () => {
    for (const base of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      for (const effort of ["low", "medium", "high"] as const) {
        expect(resolveAntigravityEffortWireModel(base, effort)).toEqual({ wireModelId: `${base}-${effort}` });
      }
    }
    const rows = parseAntigravityAvailableModels(ROSTER_55)!;
    expect(rows.find(model => model.id === "claude-opus-5-5")?.effortWireModelIds).toEqual({
      low: "claude-opus-5-5-low", medium: "claude-opus-5-5-medium", high: "claude-opus-5-5-high",
    });
  });
});

describe("account selection prefers an account whose roster lists the model", () => {
  function recordBoth(): void {
    recordAntigravityAccountRoster(PROVIDER, "acct-46", parseAntigravityAvailableModels(ROSTER_46)!);
    recordAntigravityAccountRoster(PROVIDER, "acct-55", parseAntigravityAvailableModels(ROSTER_55)!);
  }

  test("ranking keeps listing accounts, skips known non-listing ones, and keeps unknown ones", () => {
    homeWithAccounts(["acct-46", "acct-55", "acct-new"], "acct-46");
    recordBoth();
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-55"], "claude-opus-5-5")).toEqual(["acct-55"]);
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-55"], "claude-sonnet-4-6")).toEqual(["acct-46"]);
    // No roster yet means unknown, never "unsupported".
    expect(preferKiroModelSupport(PROVIDER, ["acct-46", "acct-new"], "claude-opus-5-5")).toEqual(["acct-new"]);
    // Every account's fresh roster omits it: nothing is eligible (#7500), never a fallback.
    expect(preferKiroModelSupport(PROVIDER, ["acct-46"], "claude-opus-5-5")).toEqual([]);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-new", "claude-opus-5-5")).toBeUndefined();
  });

  test("a stale roster is unknown", () => {
    homeWithAccounts(["acct-46"], "acct-46");
    recordAntigravityAccountRoster(PROVIDER, "acct-46", parseAntigravityAvailableModels(ROSTER_46)!,
      Date.now() - ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS - 1);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBeUndefined();
  });

  test("with proactive failover on, a 5.5 request leaves a 4.6-only active account", () => {
    homeWithAccounts(["acct-46", "acct-55"], "acct-46");
    recordBoth();
    const config = { providers: { [PROVIDER]: provider({ oauthAccountFailover: { enabled: true } }) } } as unknown as OcxConfig;
    expect(preferredInitialAccount(config, PROVIDER, Date.now(), "claude-opus-5-5")).toBe("acct-55");
  });

  test("with proactive failover on, a model request leaves an active lacking account for an unknown sibling (Issue #7500)", () => {
    homeWithAccounts(["acct-46", "acct-unknown"], "acct-46");
    // acct-46 has roster omitting claude-opus-5-5, acct-unknown has NO roster yet (undefined)
    recordAntigravityAccountRoster(PROVIDER, "acct-46", parseAntigravityAvailableModels(ROSTER_46)!);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-46", "claude-opus-5-5")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-unknown", "claude-opus-5-5")).toBeUndefined();

    const config = { providers: { [PROVIDER]: provider({ oauthAccountFailover: { enabled: true } }) } } as unknown as OcxConfig;
    // Must fall back to acct-unknown rather than staying on acct-46 which guarantees a 404
    expect(preferredInitialAccount(config, PROVIDER, Date.now(), "claude-opus-5-5")).toBe("acct-unknown");
  });

  test("with proactive failover on, an unseeded active account is not moved by preference alone", () => {
    homeWithAccounts(["acct-unknown", "acct-55"], "acct-unknown");
    // acct-unknown has NO roster yet (undefined), acct-55 has roster listing claude-opus-5-5 (true)
    recordAntigravityAccountRoster(PROVIDER, "acct-55", parseAntigravityAvailableModels(ROSTER_55)!);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-unknown", "claude-opus-5-5")).toBeUndefined();
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-55", "claude-opus-5-5")).toBe(true);

    const config = { providers: { [PROVIDER]: provider({ oauthAccountFailover: { enabled: true } }) } } as unknown as OcxConfig;
    // Absence of a roster is unknown, never "no": preference alone must not abandon the selected
    // account. Only a proven omission, or a reactive 404 denial, may move the request.
    expect(preferredInitialAccount(config, PROVIDER, Date.now(), "claude-opus-5-5")).toBeNull();
  });
});

describe("upstream 404 model denial and reactive failover", () => {
  test("recordAntigravityModelDenial marks account as lacking model and its wire variants", () => {
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-probe", "gemini-4-argon")).toBeUndefined();
    recordAntigravityModelDenial(PROVIDER, "acct-probe", "gemini-4-argon");
    // Wire model and base model are both recognized as unsupported
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-probe", "gemini-4-argon")).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-probe", "gemini-4-argon-high")).toBe(false);
    // Unrelated models on the account remain unknown
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-probe", "gemini-3.8-flash")).toBeUndefined();
  });

  test("model denial expires after ANTIGRAVITY_MODEL_DENIAL_TTL_MS", () => {
    const start = 1_000_000;
    recordAntigravityModelDenial(PROVIDER, "acct-exp", "gemini-4-argon", start);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-exp", "gemini-4-argon", start + 1000)).toBe(false);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-exp", "gemini-4-argon", start + ANTIGRAVITY_MODEL_DENIAL_TTL_MS + 1)).toBeUndefined();
  });

  test("a fresh discovery roster clears prior model denials for that account", () => {
    recordAntigravityModelDenial(PROVIDER, "acct-refresh", "claude-opus-5-5");
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-refresh", "claude-opus-5-5")).toBe(false);
    recordAntigravityAccountRoster(PROVIDER, "acct-refresh", parseAntigravityAvailableModels(ROSTER_55)!);
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-refresh", "claude-opus-5-5")).toBe(true);
  });

  test("rotateAntigravityAccountOnModelNotFound records denial and selects next eligible candidate", () => {
    homeWithAccounts(["acct-a", "acct-b", "acct-c"], "acct-a");
    // acct-a receives 404 for gemini-4-argon
    const next = rotateAntigravityAccountOnModelNotFound(true, "acct-a", "gemini-4-argon");
    expect(next).toBe("acct-b");
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-a", "gemini-4-argon")).toBe(false);

    // If acct-b also 404s, it advances to acct-c
    const next2 = rotateAntigravityAccountOnModelNotFound(true, "acct-b", "gemini-4-argon");
    expect(next2).toBe("acct-c");
    expect(antigravityAccountSupportsModel(PROVIDER, "acct-b", "gemini-4-argon")).toBe(false);

    // If acct-c also 404s, all accounts are denied; ring wraps but nobody is eligible
    const next3 = rotateAntigravityAccountOnModelNotFound(true, "acct-c", "gemini-4-argon");
    expect(next3).toBeNull();
  });

  test("isAntigravityModelNotFoundRefusal correctly identifies Google CCA 404 entity not found", async () => {
    const cca404 = new Response(JSON.stringify({
      error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
    }), { status: 404 });
    expect(await isAntigravityModelNotFoundRefusal(cca404)).toBe(true);

    const generic404 = new Response(JSON.stringify({
      error: { code: 404, message: "Page not found", status: "NOT_FOUND" },
    }), { status: 404 });
    expect(await isAntigravityModelNotFoundRefusal(generic404)).toBe(false);

    const cca403 = new Response(JSON.stringify({
      error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" },
    }), { status: 403 });
    expect(await isAntigravityModelNotFoundRefusal(cca403)).toBe(false);
  });
});

describe("model routing fails closed on a proven roster omission (#7500)", () => {
  const config = (enabled?: boolean) => ({ providers: { [PROVIDER]: provider(
    enabled === undefined ? {} : { oauthAccountFailover: { enabled } },
  ) } }) as unknown as OcxConfig;
  const record = (id: string, roster: unknown) =>
    recordAntigravityAccountRoster(PROVIDER, id, parseAntigravityAvailableModels(roster)!);

  test("an account that lists the model, or has no roster yet, keeps the request", () => {
    homeWithAccounts(["acct-55", "acct-new"], "acct-55");
    record("acct-55", ROSTER_55);
    expect(routeAntigravityModel(config(), PROVIDER, "acct-55", "claude-opus-5-5")).toEqual({ kind: "keep" });
    expect(routeAntigravityModel(config(), PROVIDER, "acct-new", "claude-opus-5-5")).toEqual({ kind: "keep" });
    // Other providers and model-less requests are never judged.
    expect(routeAntigravityModel(config(), "kiro", "acct-55", "claude-sonnet-4-6")).toEqual({ kind: "keep" });
    expect(routeAntigravityModel(config(), PROVIDER, "acct-55", null)).toEqual({ kind: "keep" });
  });

  test("an omitting account is replaced by a listing sibling before an unknown one", () => {
    homeWithAccounts(["acct-46", "acct-new", "acct-55"], "acct-46");
    record("acct-46", ROSTER_46);
    record("acct-55", ROSTER_55);
    expect(routeAntigravityModel(config(true), PROVIDER, "acct-46", "claude-opus-5-5"))
      .toEqual({ kind: "reroute", accountId: "acct-55" });
  });

  test("an unknown sibling serves when none lists the model, and a cooled one ranks last", () => {
    homeWithAccounts(["acct-46", "acct-cooled", "acct-new"], "acct-46");
    record("acct-46", ROSTER_46);
    record("acct-cooled", ROSTER_55);
    rotateGenericOAuthAccountOn429(config(true), PROVIDER, "acct-cooled", "120", Date.now(), "claude-opus-5-5");
    expect(routeAntigravityModel(config(true), PROVIDER, "acct-46", "claude-opus-5-5"))
      .toEqual({ kind: "reroute", accountId: "acct-new" });
  });

  test("no usable sibling serving the model refuses; paused accounts do not count", () => {
    homeWithAccounts(["acct-46", "acct-46b", "acct-paused"], "acct-46", ["acct-paused"]);
    record("acct-46", ROSTER_46);
    record("acct-46b", ROSTER_46);
    record("acct-paused", ROSTER_55);
    expect(routeAntigravityModel(config(true), PROVIDER, "acct-46", "claude-opus-5-5"))
      .toEqual({ kind: "refuse", message: antigravityModelUnlistedMessage("claude-opus-5-5") });
  });

  test("without proactive failover the selected account is not moved; the request is refused", () => {
    homeWithAccounts(["acct-46", "acct-55"], "acct-46");
    record("acct-46", ROSTER_46);
    record("acct-55", ROSTER_55);
    for (const enabled of [undefined, false]) {
      expect(routeAntigravityModel(config(enabled), PROVIDER, "acct-46", "claude-opus-5-5"))
        .toEqual({ kind: "refuse", message: antigravitySelectedAccountUnlistedMessage("claude-opus-5-5") });
      expect(antigravityModelRefusal(config(enabled), PROVIDER, "acct-46", "claude-opus-5-5"))
        .toBe(antigravitySelectedAccountUnlistedMessage("claude-opus-5-5"));
    }
    // With failover on, an omitting account that still resolved means the replacement failed;
    // the refusal must not advise enabling a setting that is already on.
    expect(antigravityModelRefusal(config(true), PROVIDER, "acct-46", "claude-opus-5-5"))
      .toBe(antigravityReplacementUnavailableMessage("claude-opus-5-5"));
    expect(antigravityModelRefusal(config(true), PROVIDER, "acct-55", "claude-opus-5-5")).toBeNull();
  });

  test("429 rotation and its target probe never pick a sibling whose roster omits the model", () => {
    homeWithAccounts(["acct-55", "acct-46"], "acct-55");
    record("acct-55", ROSTER_55);
    record("acct-46", ROSTER_46);
    expect(hasEligibleGenericOAuthFailoverTarget(PROVIDER, "acct-55", Date.now(), "claude-opus-5-5")).toBe(false);
    expect(rotateGenericOAuthAccountOn429(config(true), PROVIDER, "acct-55", null, Date.now(), "claude-opus-5-5")).toBeNull();
    // The sibling still serves a model it lists.
    expect(hasEligibleGenericOAuthFailoverTarget(PROVIDER, "acct-55", Date.now(), "gemini-3.8-flash")).toBe(true);
  });

  test("auth-refusal rotation walks past an omitting sibling to one that may serve", () => {
    homeWithAccounts(["acct-a", "acct-46", "acct-55"], "acct-a");
    record("acct-a", ROSTER_55);
    record("acct-46", ROSTER_46);
    record("acct-55", ROSTER_55);
    expect(rotateAntigravityAccountOnAuthRefusal(true, "acct-a", "stale-generation", "claude-opus-5-5")).toBe("acct-55");
    clearAntigravityAccountRosters(PROVIDER, "acct-55");
    record("acct-55", ROSTER_46);
    expect(rotateAntigravityAccountOnAuthRefusal(true, "acct-a", "stale-generation", "claude-opus-5-5")).toBeNull();
  });

  test("round-robin rotates across model-supporting accounts per family without resetting weights", () => {
    clearPoolRotationState();
    homeWithAccounts(["acct-46a", "acct-55a", "acct-46b", "acct-55b"], "acct-46a");
    record("acct-46a", ROSTER_46);
    record("acct-55a", ROSTER_55);
    record("acct-46b", ROSTER_46);
    record("acct-55b", ROSTER_55);

    const rrConfig = {
      pool: { kernel: true },
      providers: {
        [PROVIDER]: provider({
          oauthAccountFailover: { enabled: true, strategy: "round-robin", stickyLimit: 1 },
        }),
      },
    } as unknown as OcxConfig;

    // First 5.5 pick should choose acct-55a, and committing via noteGenericPoolSelection must not reset SWRR weights
    const pick1 = preferredInitialAccount(rrConfig, PROVIDER, Date.now(), "claude-opus-5-5") ?? "acct-46a";
    expect(pick1).toBe("acct-55a");
    noteGenericPoolSelection(rrConfig, PROVIDER, pick1, "claude-opus-5-5");

    // Second 5.5 pick must advance to acct-55b (previously stuck on acct-55a because noteGenericPoolSelection cleared weights)
    const pick2 = preferredInitialAccount(rrConfig, PROVIDER, Date.now(), "claude-opus-5-5") ?? "acct-46a";
    expect(pick2).toBe("acct-55b");
    noteGenericPoolSelection(rrConfig, PROVIDER, pick2, "claude-opus-5-5");

    // Third 5.5 pick wraps back to acct-55a
    const pick3 = preferredInitialAccount(rrConfig, PROVIDER, Date.now(), "claude-opus-5-5") ?? "acct-46a";
    expect(pick3).toBe("acct-55a");
  });
});
