export * from "./types";
export * from "./redact";
export * from "./stats";

import type { OcxConfig } from "../types";
import type { RedactOptions } from "./redact";

/**
 * Whether client-request privacy redaction is on. Config `privacy.enabled`, or the
 * `OPENCODEX_PRIVACY_REDACTION=1`/`true` environment variable, per privacy_contract.md.
 * Default OFF: an absent or malformed config block never turns this on by accident.
 */
export function isPrivacyRedactionEnabled(config?: OcxConfig | null): boolean {
  if (process.env.OPENCODEX_PRIVACY_REDACTION === "1" || process.env.OPENCODEX_PRIVACY_REDACTION === "true") {
    return true;
  }
  return config?.privacy?.enabled === true;
}

/** `privacy.allowValues` / `privacy.maskEmails` projected into redactor options. */
export function privacyOptionsFromConfig(config: OcxConfig | null | undefined): RedactOptions {
  return {
    allowValues: config?.privacy?.allowValues ?? [],
    redactEmails: config?.privacy?.maskEmails === true,
  };
}

/** Best-effort client label for stats, from the request's own User-Agent header. */
export function clientLabelFromHeaders(headers: Headers): string | undefined {
  const ua = headers.get("user-agent")?.trim();
  if (!ua) return undefined;
  return ua.slice(0, 120);
}
