/**
 * Shared types for client-request privacy redaction.
 *
 * Single source of truth for the redaction "kind" vocabulary used by the
 * redactor, the in-memory stats ring buffer, and the management API. See
 * `D:\Andrew\Code\tests\_inv\privacy_contract.md` for the cross-team contract
 * this module implements.
 */

/** Fixed vocabulary -- never widen this without updating the management contract. */
export type RedactionKind =
  | "api_key"
  | "password"
  | "token"
  | "private_key"
  | "connection_string"
  | "email"
  | "other";

/** One kind's occurrence count within a single request. Never carries the original value. */
export interface RedactionHit {
  kind: RedactionKind;
  count: number;
}

/** Result of running the redactor over one client request body. */
export interface RedactionOutcome {
  body: unknown;
  hits: RedactionHit[];
  /** sha256-prefix hashes of the distinct secret values redacted (never the values themselves). */
  placeholderHashes: string[];
}

/** Result of `POST /api/privacy/test`. */
export interface PrivacyTestResult {
  masked: string;
  hits: RedactionHit[];
}

/** One retained request record in the stats ring buffer. */
export interface PrivacyRequestRecord {
  id: string;
  ts: number;
  client?: string;
  provider?: string;
  model?: string;
  hits: RedactionHit[];
  placeholderHashes: string[];
}

export type PrivacyStatsRange = "7d" | "30d";

export interface PrivacyStatsSummary {
  enabled: boolean;
  range: PrivacyStatsRange;
  totals: { masked: number; distinctValues: number; requests: number };
  daily: Array<{ date: string; masked: number }>;
  flows: Array<{ client: string; provider: string; masked: number }>;
  requests: Array<{
    id: string;
    ts: string;
    client: string;
    provider: string;
    model: string;
    hits: RedactionHit[];
    total: number;
  }>;
}
