/** Client-request redaction fields of `privacy` (src/privacy/). Split out of config.ts for the file-size ratchet. */
export interface OcxPrivacyRedactionConfig {
  /** Turns on client-request body redaction (secrets -> `{{SECRET_xxxxxxxx}}`). Default off. */
  enabled?: boolean;
  /** Exact-match original values that client-request redaction must leave untouched. */
  allowValues?: string[];
  /**
   * Two-way mode: restore the placeholders a model echoes back to the original values, for the
   * client that sent them. Requires `enabled`. Default off (redaction stays one-way).
   */
  restoreResponses?: boolean;
  /**
   * With `restoreResponses`, also restore placeholders inside tool-call arguments. Default off:
   * a restored value there is something a tool can execute or transmit.
   */
  restoreToolArguments?: boolean;
  /**
   * Opt-in reveal mode: keep the original of each redacted value in memory so the operator can
   * list them (`GET /api/privacy/values`, admin token) and spot false positives. Real secrets
   * sit in the process's memory while this is on; they are never written to disk or logs.
   * Default off.
   */
  revealValues?: boolean;
}
