/**
 * Wire shapes for the request-redaction management API.
 *
 * The three routes and every field name below are the contract the backend owns
 * (`GET /api/privacy/stats`, `GET|PUT /api/privacy/config`, `POST /api/privacy/test`).
 * Stats records carry a KIND and a COUNT and nothing else. The one exception is opt-in reveal
 * mode (`GET /api/privacy/values`), whose `PrivacyRevealedValue` holds the originals.
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

/**
 * An allowlisted value as the GUI is allowed to know it: a hash-prefix id and a length.
 *
 * The original never crosses the wire any more, so the page cannot render it even by mistake.
 * The id is the same digest a redacted occurrence of that value carries inside its placeholder,
 * which is also how a row is addressed for deletion.
 */
export interface PrivacyAllowValue {
  id: string;
  length: number;
}

export interface PrivacyConfig {
  enabled: boolean;
  /** Reveal mode: the server keeps each redacted original in memory for `GET /api/privacy/values`. */
  revealValues: boolean;
  allowValues: PrivacyAllowValue[];
}

/**
 * One distinct redacted original, served only in reveal mode. The single type on this page that
 * holds a real value: it is rendered hidden until the operator asks to see it.
 */
export interface PrivacyRevealedValue {
  /** Same hash-prefix id an allow-list entry for this value carries. */
  id: string;
  kind: PrivacyKind;
  value: string;
  /** A short window of the surrounding text, or `field "<name>"`. Contains the value. */
  context: string;
  requests: number;
  /** Ids of the requests (as in `PrivacyStats.requests`) that carried it. */
  requestIds: string[];
  lastSeen: string;
}

export interface PrivacyValues {
  reveal: boolean;
  values: PrivacyRevealedValue[];
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
