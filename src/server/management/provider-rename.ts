import { isDeepStrictEqual } from "node:util";
import { isValidProviderName, mutatePersistedConfig, validateConfigCandidate } from "../../config";
import { refreshConfigDerivedRegistries } from "../../config/derived-registries";
import { getProviderRegistryEntry } from "../../providers/registry";
import { providerConfigSeed } from "../../providers/derive";
import { rewriteProviderReferences } from "../../providers/provider-id-rewrite";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { clearModelCache } from "../../codex/model-cache";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import { clearProviderQuotaCache } from "../../providers/quota";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { jsonResponse } from "../auth-cors";
import type { OcxConfig } from "../../types";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

export function renameProvider(config: OcxConfig, from: string, to: string): void {
  if (!isValidProviderName(from) || !isValidProviderName(to)) throw new Error("invalid_provider_name");
  if (!Object.hasOwn(config.providers, from)) throw new Error("provider_not_found");
  if (from === to) return;
  if (Object.hasOwn(config.providers, to)) throw new Error("provider_already_exists");
  const registry = getProviderRegistryEntry(from);
  const provider = { ...(registry ? providerConfigSeed(registry) : {}), ...config.providers[from]! };
  if (provider.authMode === "oauth" || provider.authMode === "forward" || provider.anthropicOAuthInstance) {
    throw new Error("provider_identity_is_reserved");
  }
  if (getProviderRegistryEntry(to)) throw new Error("provider_identity_is_reserved");
  if (codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, to)) throw new Error("provider_namespace_conflict");
  const candidate = structuredClone(config);
  candidate.providers = Object.fromEntries(Object.entries(candidate.providers)
    .map(([name, row]) => name === from ? [to, provider] : [name, row]));
  if (rewriteProviderReferences(candidate, from, to).collisions.length) throw new Error("provider_reference_conflict");
  const validation = validateConfigCandidate(candidate);
  if (!validation.ok) throw new Error("invalid_renamed_provider_config");
  Object.assign(config, candidate);
}

export async function handleProviderRename(ctx: ManagementContext): Promise<Response> {
  let body: { from?: unknown; to?: unknown };
  try { body = await readManagementJsonBody(ctx.req); }
  catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.from !== "string" || typeof body.to !== "string") return jsonResponse({ error: "from and to are required" }, 400);
  const from = body.from.trim();
  const to = body.to.trim();
  let changedKeys: string[] = [];
  try {
    const outcome = mutatePersistedConfig(config => {
      const before = structuredClone(config);
      renameProvider(config, from, to);
      changedKeys = Object.keys(config).filter(key => !isDeepStrictEqual(
        (before as unknown as Record<string, unknown>)[key], (config as unknown as Record<string, unknown>)[key]));
      return { changed: changedKeys.length > 0, value: config };
    });
    if (outcome.status === "unavailable") return jsonResponse({ error: "provider_config_unavailable" }, 409);
    for (const key of changedKeys) {
      (ctx.config as unknown as Record<string, unknown>)[key] = structuredClone((outcome.value as unknown as Record<string, unknown>)[key]);
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "provider_rename_failed";
    const known = /^(invalid_provider_name|provider_not_found|provider_already_exists|provider_identity_is_reserved|provider_namespace_conflict|provider_reference_conflict|invalid_renamed_provider_config)$/;
    if (!known.test(code)) throw error;
    return jsonResponse({ error: code }, 409);
  }
  reconcileLiveStateStores();
  refreshConfigDerivedRegistries(ctx.config);
  clearModelCache();
  clearGatherRoutedModelsInflight();
  clearProviderQuotaCache();
  const catalogRefresh = await ctx.convergeCodexCatalog();
  return jsonResponse({ success: true, name: to, catalogRefresh });
}
