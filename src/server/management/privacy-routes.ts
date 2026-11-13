import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { isPlainRecord } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { saveConfigPreservingClaudeCode } from "../../config";
import {
  globalPrivacyStats,
  isPrivacyRedactionEnabled,
  privacyOptionsFromConfig,
  redactPlainText,
  secretValueId,
} from "../../privacy";
import type { PrivacyStatsRange } from "../../privacy";

const MAX_ALLOW_VALUE_LENGTH = 4096;
const ALLOW_VALUES_PREFIX = "/api/privacy/allow-values/";

function parseRange(url: URL): PrivacyStatsRange {
  const raw = url.searchParams.get("range");
  return raw === "30d" ? "30d" : "7d";
}

/**
 * The config as every config-writing route answers it. `allowValues` is projected: never the
 * original value, only its id and length.
 */
function configView(config: ManagementContext["config"]) {
  return {
    enabled: config.privacy?.enabled === true,
    revealValues: config.privacy?.revealValues === true,
    allowValues: (config.privacy?.allowValues ?? []).map((value) => ({ id: secretValueId(value), length: value.length })),
  };
}

/**
 * Management API routes for privacy redaction (privacy_contract.md):
 * - GET    /api/privacy/stats?range=7d|30d
 * - GET    /api/privacy/config
 * - PUT    /api/privacy/config                 (`{ enabled?: boolean, revealValues?: boolean }`)
 * - GET    /api/privacy/values?range=&limit=&kind=   (reveal mode only: the originals, admin token)
 * - POST   /api/privacy/test
 * - POST   /api/privacy/allow-values            (`{ value: string }`)
 * - DELETE /api/privacy/allow-values/{id}
 *
 * The original value of an allowlisted entry lives ONLY in the server's own config; it is
 * never echoed back by any of these routes, never logged, and never appears in an error
 * message -- the GUI addresses an entry by the same hash-prefix `id` a redacted occurrence of
 * that value would carry as its placeholder. `/test` deliberately does not log or persist the
 * raw `text` it is given either, and the stats endpoint never returns an original secret value
 * or any prefix of one -- only kinds, counts, and hash-derived ids.
 */
export async function handlePrivacyRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/privacy/stats" && req.method === "GET") {
    const range = parseRange(url);
    const summary = globalPrivacyStats.summary(range, isPrivacyRedactionEnabled(config));
    return jsonResponse(summary, 200, req, config);
  }

  // Reveal mode (opt-in `privacy.revealValues`): the originals the redactor replaced, for the
  // operator to check for false positives. Behind the same admin token as every management
  // route; with the flag off nothing was retained, so the answer is an empty list.
  if (url.pathname === "/api/privacy/values" && req.method === "GET") {
    const reveal = config.privacy?.revealValues === true;
    if (!reveal) return jsonResponse({ reveal: false, values: [] }, 200, req, config);
    const kind = url.searchParams.get("kind");
    const limitRaw = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 100;
    const all = globalPrivacyStats.revealedValues(parseRange(url), 1000);
    const values = (kind ? all.filter((value) => value.kind === kind) : all).slice(0, limit);
    return jsonResponse({ reveal: true, values }, 200, req, config);
  }

  if (url.pathname === "/api/privacy/config" && req.method === "GET") {
    return jsonResponse(configView(config), 200, req, config);
  }

  if (url.pathname === "/api/privacy/config" && req.method === "PUT") {
    return handlePutConfig(ctx);
  }

  if (url.pathname === "/api/privacy/test" && req.method === "POST") {
    return handleTest(ctx);
  }

  if (url.pathname === "/api/privacy/allow-values" && req.method === "POST") {
    return handleAddAllowValue(ctx);
  }

  if (req.method === "DELETE" && url.pathname.startsWith(ALLOW_VALUES_PREFIX)) {
    return handleDeleteAllowValue(ctx, url.pathname.slice(ALLOW_VALUES_PREFIX.length));
  }

  return null;
}

async function handlePutConfig(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let raw: unknown;
  try {
    raw = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }
  if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400, req, config);
  const body = raw as { enabled?: unknown; revealValues?: unknown };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return jsonResponse({ error: "enabled must be a boolean" }, 400, req, config);
  }
  if (body.revealValues !== undefined && typeof body.revealValues !== "boolean") {
    return jsonResponse({ error: "revealValues must be a boolean" }, 400, req, config);
  }
  if (body.enabled === undefined && body.revealValues === undefined) {
    return jsonResponse({ error: "enabled must be a boolean" }, 400, req, config);
  }
  config.privacy = {
    ...config.privacy,
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.revealValues === undefined ? {} : { revealValues: body.revealValues }),
  };
  saveConfigPreservingClaudeCode(config);
  // Turning reveal off must not leave the originals sitting in memory.
  if (body.revealValues === false) globalPrivacyStats.dropSamples();
  return jsonResponse(configView(config), 200, req, config);
}

async function handleTest(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let raw: unknown;
  try {
    raw = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }
  if (!isPlainRecord(raw) || typeof raw.text !== "string") {
    return jsonResponse({ error: "body must be { text: string }" }, 400, req, config);
  }
  try {
    const outcome = redactPlainText(raw.text, privacyOptionsFromConfig(config));
    return jsonResponse({ masked: outcome.body, hits: outcome.hits }, 200, req, config);
  } catch {
    return jsonResponse({ error: "redaction failed" }, 503, req, config);
  }
}

async function handleAddAllowValue(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let raw: unknown;
  try {
    raw = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }
  if (!isPlainRecord(raw) || typeof raw.value !== "string") {
    return jsonResponse({ error: "body must be { value: string }" }, 400, req, config);
  }
  const value = raw.value;
  if (value.length === 0 || value.length > MAX_ALLOW_VALUE_LENGTH) {
    return jsonResponse({ error: `value must be 1-${MAX_ALLOW_VALUE_LENGTH} characters` }, 400, req, config);
  }
  const existing = config.privacy?.allowValues ?? [];
  if (!existing.includes(value)) {
    config.privacy = { ...config.privacy, allowValues: [...existing, value] };
    saveConfigPreservingClaudeCode(config);
  }
  return jsonResponse(configView(config), 200, req, config);
}

async function handleDeleteAllowValue(ctx: ManagementContext, rawId: string): Promise<Response> {
  const { req, config } = ctx;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return jsonResponse({ error: "invalid id" }, 400, req, config);
  }
  const existing = config.privacy?.allowValues ?? [];
  const next = existing.filter((value) => secretValueId(value) !== id);
  if (next.length === existing.length) {
    return jsonResponse({ error: "not found" }, 404, req, config);
  }
  config.privacy = { ...config.privacy, allowValues: next };
  saveConfigPreservingClaudeCode(config);
  return jsonResponse(configView(config), 200, req, config);
}
