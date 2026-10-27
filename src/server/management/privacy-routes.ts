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

/** `allowValues` projected for the GUI: never the original value, only its id and length. */
function allowValuesView(config: ManagementContext["config"]): Array<{ id: string; length: number }> {
  return (config.privacy?.allowValues ?? []).map((value) => ({ id: secretValueId(value), length: value.length }));
}

/**
 * Management API routes for privacy redaction (privacy_contract.md):
 * - GET    /api/privacy/stats?range=7d|30d
 * - GET    /api/privacy/config
 * - PUT    /api/privacy/config                 (`{ enabled: boolean }` only)
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

  if (url.pathname === "/api/privacy/config" && req.method === "GET") {
    return jsonResponse({ enabled: config.privacy?.enabled === true, allowValues: allowValuesView(config) }, 200, req, config);
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
  const body = raw as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return jsonResponse({ error: "enabled must be a boolean" }, 400, req, config);
  }
  config.privacy = { ...config.privacy, enabled: body.enabled };
  saveConfigPreservingClaudeCode(config);
  return jsonResponse({ enabled: config.privacy.enabled === true, allowValues: allowValuesView(config) }, 200, req, config);
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
  return jsonResponse({ enabled: config.privacy?.enabled === true, allowValues: allowValuesView(config) }, 200, req, config);
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
  return jsonResponse({ enabled: config.privacy.enabled === true, allowValues: allowValuesView(config) }, 200, req, config);
}
