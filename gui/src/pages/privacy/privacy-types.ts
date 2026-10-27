/**
 * Wire shapes for the request-redaction management API.
 *
 * The three routes and every field name below are the contract the backend owns
 * (`GET /api/privacy/stats`, `GET|PUT /api/privacy/config`, `POST /api/privacy/test`).
 * The one rule the whole surface is built around: a record carries a KIND and a COUNT and
 * nothing else — no secret value, and no prefix of one — so there is no field here that
 * could ever hold one.
 */

/** Closed set. The backend never invents a kind; an unknown one is folded into `other`. */
export const PRIVACY_KINDS = [
  "api_key",
  "password",
  "token",
  "private_key",
  "connection_string",
  "email",
  "other",
] as const;

export type PrivacyKind = (typeof PRIVACY_KINDS)[number];

export type PrivacyRange = "7d" | "30d";

export interface PrivacyHit {
  kind: PrivacyKind;
  count: number;
}

export interface PrivacyRequestRecord {
  id: string;
  /** ISO-8601 instant the request was redacted. */
  ts: string;
  client: string;
  provider: string;
  model: string;
  hits: PrivacyHit[];
  total: number;
}

export interface PrivacyFlow {
  client: string;
  provider: string;
  masked: number;
}

export interface PrivacyDay {
  date: string;
  masked: number;
}

export interface PrivacyStats {
  enabled: boolean;
  range: PrivacyRange;
  totals: { masked: number; distinctValues: number; requests: number };
  daily: PrivacyDay[];
  flows: PrivacyFlow[];
  requests: PrivacyRequestRecord[];
}

export interface PrivacyConfig {
  enabled: boolean;
  /**
   * Values the user chose to let through unredacted. They are only ever counted on screen:
   * no surface renders an element, title, or aria string built from one.
   */
  allowValues: string[];
}

export interface PrivacyTestResult {
  masked: string;
  hits: PrivacyHit[];
}

const KIND_SET: ReadonlySet<string> = new Set(PRIVACY_KINDS);

/** Boundary defence: anything outside the closed set still has to render as something. */
export function asPrivacyKind(value: unknown): PrivacyKind {
  return typeof value === "string" && KIND_SET.has(value) ? (value as PrivacyKind) : "other";
}
