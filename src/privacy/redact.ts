import { createHash } from "node:crypto";
import type { RedactionHit, RedactionKind, RedactionOutcome } from "./types";

/**
 * Client-request redaction engine.
 *
 * Design (see privacy_contract.md): one-way by default, no restoration. The placeholder is a
 * deterministic hash of the secret value (`{{SECRET_xxxxxxxx}}`, 8 hex chars of its sha256),
 * so the SAME secret always produces the SAME placeholder across requests and across process
 * restarts without needing any stored mapping. Reply-direction restoration (`privacy.restoreResponses`,
 * ./restore.ts) is opt-in and works from a REQUEST-SCOPED, memory-only map that a caller asks for with
 * `collectRestoreMap`; without that option nothing here retains an original value.
 *
 * Fields that must never be touched (protocol signatures, encrypted payloads, base64 blobs,
 * and plain structural identifiers) are skipped by key name. A `thinking` block carrying a
 * non-empty `signature`, and any `redacted_thinking` block, are skipped WHOLE -- not just the
 * signature field -- because the content next to a verified signature must round-trip
 * byte-for-byte or the upstream provider rejects the turn.
 */

export const PLACEHOLDER_PREFIX = "{{SECRET_";
export const PLACEHOLDER_SUFFIX = "}}";
export const PLACEHOLDER_REGEX = /\{\{SECRET_[0-9a-fA-F]{8}\}\}/;

function sha256Prefix8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export function generatePlaceholder(secret: string): string {
  return `${PLACEHOLDER_PREFIX}${sha256Prefix8(secret)}${PLACEHOLDER_SUFFIX}`;
}

/**
 * The same hash-prefix identity a redacted value's placeholder carries, exposed for
 * `privacy.allowValues` management: the GUI lists and deletes allowlisted values by this id
 * without the server ever echoing the original value back (privacy_contract.md).
 */
export function secretValueId(value: string): string {
  return sha256Prefix8(value);
}

function placeholderHash(placeholder: string): string {
  return placeholder.slice(PLACEHOLDER_PREFIX.length, placeholder.length - PLACEHOLDER_SUFFIX.length);
}

function isAlreadyPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX) && value.endsWith(PLACEHOLDER_SUFFIX)
    && PLACEHOLDER_REGEX.test(value);
}

/**
 * Structural / protocol fields that are never scanned, regardless of position. Keeping this a
 * flat key-name list (rather than per-protocol path allowlists) is the point: a field the three
 * protocols don't yet know about still gets redacted by default, and only this short, reviewed
 * list is exempt. See privacy_contract.md "绝对不能改动的字段".
 */
const SKIPPED_KEYS = new Set([
  // Structural identifiers -- never secrets, and rewriting them breaks protocol dispatch.
  "id", "call_id", "tool_use_id", "name", "model", "type", "role",
  // Protocol signatures / encrypted payloads -- must round-trip byte-for-byte.
  "signature", "thoughtsignature", "thought_signature", "encrypted_content", "encryptedcontent",
  // Base64 / data-URL blobs for images and files.
  "image_url", "inlinedata", "file_data", "filedata",
]);

function isSkippedKey(key: string): boolean {
  return SKIPPED_KEYS.has(key.toLowerCase());
}

/** Does an object KEY name itself look like a credential variable name? */
const SENSITIVE_NAME_PATTERN = /(?:key|secret|token|password|passwd|pwd)/i;

function kindForFieldName(key: string): RedactionKind {
  const lower = key.toLowerCase();
  if (lower.includes("password") || lower.includes("passwd") || lower.includes("pwd")) return "password";
  if (lower.includes("token")) return "token";
  return "api_key";
}

/** Minimum length for a bare field VALUE to count as a secret by name alone. */
const MIN_NAMED_SECRET_LEN = 6;

/** Anthropic `source: { type, media_type, data }` / Gemini `inlineData: { mimeType, data }` shape. */
function hasInlineMediaMarker(obj: Record<string, unknown>): boolean {
  return typeof obj.media_type === "string" || typeof obj.mime_type === "string" || typeof obj.mimeType === "string";
}

export interface RedactOptions {
  /** Exact-match original values that must never be redacted (privacy.allowValues). */
  allowValues?: ReadonlySet<string> | readonly string[];
  /** Whether the email rule is active. Default false: email is `kind: "email"` but opt-in. */
  redactEmails?: boolean;
  /**
   * Also return the placeholder -> original map on `outcome.restoreMap` (request-scoped, memory
   * only, for reply-direction restoration). Off by default: the one-way path keeps no originals.
   */
  collectRestoreMap?: boolean;
}

interface RuleMatch {
  fullMatch: string;
  secret: string;
  prefix: string;
  suffix: string;
  kind: RedactionKind;
}

interface Rule {
  kind: RedactionKind;
  /** Must be a fresh RegExp with the `g` flag; never reused across calls (lastIndex state). */
  pattern: () => RegExp;
  extract?: (m: RegExpExecArray) => { fullMatch: string; secret: string; prefix?: string; suffix?: string };
}

const RULES: Rule[] = [
  // Private key PEM blocks -- replace the WHOLE block as one unit so no fragment of the key
  // material survives, including the base64 payload between BEGIN/END.
  {
    kind: "private_key",
    pattern: () => /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]+?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  },
  // Connection string password: proto://user:PASSWORD@host -- only the password segment is secret.
  {
    kind: "connection_string",
    pattern: () => /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)([^\s:@/]+)(@[^\s/]+)/g,
    extract: (m) => ({ fullMatch: m[0], secret: m[2]!, prefix: m[1], suffix: m[3] }),
  },
  // Google API key.
  { kind: "api_key", pattern: () => /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // OpenAI / Anthropic sk- / sk-ant- tokens.
  { kind: "api_key", pattern: () => /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g },
  // AWS access key id.
  { kind: "api_key", pattern: () => /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic, fine-grained, oauth).
  { kind: "api_key", pattern: () => /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // JWTs (three dot-separated base64url segments).
  { kind: "token", pattern: () => /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g },
  // Bearer <token>.
  {
    kind: "token",
    pattern: () => /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})\b/gi,
    extract: (m) => ({ fullMatch: m[0], secret: m[2]!, prefix: m[1] }),
  },
  // Generic KEY=VALUE / "key": "value" credential assignment, matched by variable NAME rather
  // than value shape ("宁可误报，不要漏报"): any name containing key/secret/token/password/passwd/pwd
  // assigned a sufficiently long value is treated as a secret, in free text, query strings, JSON,
  // and .env-style lines (`XXX_KEY=...`, `XXX_SECRET=...`, `XXX_TOKEN=...`) alike.
  {
    kind: "other",
    pattern: () => /(["']?[A-Za-z][A-Za-z0-9_-]*?(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["']?)([A-Za-z0-9+/_.~-]{8,})\2/gi,
    extract: (m) => {
      const label = m[0]!.toLowerCase();
      const kind: RedactionKind = label.includes("password") || label.includes("passwd") || label.includes("pwd")
        ? "password"
        : label.includes("token")
          ? "token"
          : "api_key";
      return { fullMatch: m[0], secret: m[3]!, prefix: `${m[1]}${m[2] ?? ""}`, suffix: m[2] ?? "" };
    },
  },
];

const EMAIL_RULE: Rule = { kind: "email", pattern: () => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g };

/** Thrown only for genuinely unexpected failures; callers map this to a fail-closed 503. */
export class PrivacyRedactionError extends Error {
  constructor(cause: unknown) {
    super(`privacy redaction failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PrivacyRedactionError";
  }
}

class RedactionSession {
  private readonly allow: ReadonlySet<string>;
  private readonly redactEmails: boolean;
  private readonly hits = new Map<RedactionKind, number>();
  private readonly hashes = new Set<string>();
  private readonly collect: boolean;
  private readonly restore = new Map<string, string>();
  /** Placeholders whose 8-hex prefix collided across two values: never restored (fail-safe). */
  private readonly ambiguous = new Set<string>();

  constructor(options: RedactOptions) {
    this.allow = options.allowValues instanceof Set
      ? options.allowValues
      : new Set(options.allowValues ?? []);
    this.redactEmails = options.redactEmails === true;
    this.collect = options.collectRestoreMap === true;
  }

  outcome(body: unknown): RedactionOutcome {
    const hits: RedactionHit[] = [];
    for (const [kind, count] of this.hits) hits.push({ kind, count });
    return {
      body,
      hits,
      placeholderHashes: [...this.hashes],
      ...(this.collect ? { restoreMap: this.restore } : {}),
    };
  }

  private recordHit(kind: RedactionKind, secretHash: string, secret: string): void {
    this.hits.set(kind, (this.hits.get(kind) ?? 0) + 1);
    this.hashes.add(secretHash);
    if (!this.collect) return;
    const placeholder = `${PLACEHOLDER_PREFIX}${secretHash}${PLACEHOLDER_SUFFIX}`;
    if (this.ambiguous.has(placeholder)) return;
    const known = this.restore.get(placeholder);
    if (known === undefined) this.restore.set(placeholder, secret);
    else if (known !== secret) {
      this.restore.delete(placeholder);
      this.ambiguous.add(placeholder);
    }
  }

  private applyRule(text: string, rule: Rule): string {
    const regex = rule.pattern();
    const matches: RuleMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      let secret: string;
      let prefix = "";
      let suffix = "";
      let fullMatch = m[0];
      if (rule.extract) {
        const ext = rule.extract(m);
        secret = ext.secret;
        prefix = ext.prefix ?? "";
        suffix = ext.suffix ?? "";
        fullMatch = ext.fullMatch;
      } else {
        secret = m[0];
      }
      if (!secret || isAlreadyPlaceholder(secret)) continue;
      matches.push({ fullMatch, secret, prefix, suffix, kind: rule.kind });
      // Prevent a zero-length match (shouldn't occur with these patterns) from looping forever.
      if (m[0].length === 0) regex.lastIndex += 1;
    }
    if (matches.length === 0) return text;
    let result = text;
    for (const match of matches) {
      if (this.allow.has(match.secret)) continue;
      const placeholder = generatePlaceholder(match.secret);
      const replacement = `${match.prefix}${placeholder}${match.suffix}`;
      result = result.split(match.fullMatch).join(replacement);
      this.recordHit(match.kind, placeholderHash(placeholder), match.secret);
    }
    return result;
  }

  redactPlainText(text: string): string {
    let result = text;
    for (const rule of RULES) result = this.applyRule(result, rule);
    if (this.redactEmails) result = this.applyRule(result, EMAIL_RULE);
    return result;
  }

  redactString(value: string): string {
    // `function_call.arguments`-style JSON-string-within-JSON-string fields must still parse
    // after redaction. Recursing through the parsed structure and re-serializing guarantees
    // that, and sidesteps quote/backslash escaping entirely (JSON.stringify re-escapes for us),
    // rather than trying to regex-substitute inside the still-escaped string text.
    const trimmed = value.trim();
    const looksLikeJson = (trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (looksLikeJson) {
      try {
        const parsed = JSON.parse(value);
        const redacted = this.redactValue(parsed);
        return JSON.stringify(redacted);
      } catch {
        // Not actually JSON (e.g. a free-text string that happens to start with "{"); fall
        // through to plain-text redaction below.
      }
    }
    return this.redactPlainText(value);
  }

  /**
   * Redact an entire string value because its OWN field name looks like a credential
   * variable (`password`, `apiKey`, `FOO_SECRET`, ...) -- not because any text pattern
   * matched inside it. This is what catches a bare high-entropy value sitting in a JSON
   * field or a JS object, which carries no in-text marker for the regex rules to find.
   * "宁可误报，不要漏报" (privacy_contract.md): a short, low-entropy value is still left
   * alone via MIN_NAMED_SECRET_LEN, so an enum-like `"keyType": "ec"` is not touched.
   */
  private redactNamedValue(value: string, kind: RedactionKind): string {
    if (value.length < MIN_NAMED_SECRET_LEN || isAlreadyPlaceholder(value) || this.allow.has(value)) {
      return value;
    }
    const placeholder = generatePlaceholder(value);
    this.recordHit(kind, placeholderHash(placeholder), value);
    return placeholder;
  }

  redactValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value; // Date, Buffer, etc.
      const obj = value as Record<string, unknown>;
      // A verified thinking block, or any redacted_thinking block, must round-trip whole.
      if (obj.type === "thinking" && typeof obj.signature === "string" && obj.signature.length > 0) return obj;
      if (obj.type === "redacted_thinking") return obj;
      const inlineMedia = hasInlineMediaMarker(obj);
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(obj)) {
        if (isSkippedKey(key)) { result[key] = v; continue; }
        if (inlineMedia && key.toLowerCase() === "data") { result[key] = v; continue; }
        if (typeof v === "string" && SENSITIVE_NAME_PATTERN.test(key)) {
          result[key] = this.redactNamedValue(v, kindForFieldName(key));
          continue;
        }
        result[key] = this.redactValue(v);
      }
      return result;
    }
    return value; // number, boolean
  }
}

/**
 * Redact one client request body (or a plain string, for `POST /api/privacy/test`).
 *
 * Does not mutate `body` in place -- callers reassign their own `body`/`chatBody`/`anthropicBody`
 * variable to `.body` from the result BEFORE any further processing. Throws
 * `PrivacyRedactionError` only for a genuine internal failure; callers must treat that as
 * fail-closed (503, do not send upstream) per privacy_contract.md.
 */
export function redactClientBody(body: unknown, options: RedactOptions = {}): RedactionOutcome {
  try {
    const session = new RedactionSession(options);
    const redacted = session.redactValue(body);
    return session.outcome(redacted);
  } catch (err) {
    if (err instanceof PrivacyRedactionError) throw err;
    throw new PrivacyRedactionError(err);
  }
}

/** Plain-text variant for `POST /api/privacy/test`; same engine, no object traversal. */
export function redactPlainText(text: string, options: RedactOptions = {}): RedactionOutcome {
  try {
    const session = new RedactionSession(options);
    const redacted = session.redactPlainText(text);
    return session.outcome(redacted);
  } catch (err) {
    if (err instanceof PrivacyRedactionError) throw err;
    throw new PrivacyRedactionError(err);
  }
}
