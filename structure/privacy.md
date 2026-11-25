# Client-Request Privacy Redaction

`src/privacy/` is the opt-in redaction layer for client request bodies. It is off unless
`privacy.enabled` is true in config or `OPENCODEX_PRIVACY_REDACTION` is `1` or `true`
(`isPrivacyRedactionEnabled` in `src/privacy/index.ts`); an absent or malformed block never enables it.
The `privacy` block is declared in `src/types/config.ts` and follows the [config surface](config.md).

## Request direction

`src/privacy/redact.ts` replaces each detected secret with `{{SECRET_xxxxxxxx}}`, where the eight hex
characters are a prefix of the value's sha256. The same value therefore maps to the same placeholder
across requests and restarts without a stored mapping. `privacy.allowValues` lists exact values that are
left untouched. Protocol signatures, encrypted payloads, base64 blobs and structural identifiers are
skipped by key name; a `thinking` block with a non-empty `signature` and every `redacted_thinking` block
are skipped whole, because that content must round-trip byte for byte.

Redaction runs at the Responses, Chat Completions and Messages entry points and on the Claude Code
intercept path: `src/server/responses/request-prepare.ts`, `src/server/chat-completions.ts`,
`src/server/claude-messages.ts` and `src/claude/intercept/runtime.ts`. The Claude Desktop picker relay
is outside it; see [Claude Desktop](clients/claude-desktop.md).

## Reply direction

Redaction is one-way by default. `privacy.restoreResponses` opts into restoring echoed placeholders
in `src/privacy/restore.ts`:

- The placeholder map is request-scoped and memory-only; it is never persisted, logged or counted.
- Restoration runs on the outermost response, after the request-log and usage taps saw the masked stream.
- A placeholder absent from this request's map stays a placeholder, so another request's value cannot appear.
- A rewriting failure keeps the masked bytes.
- Only assistant output text is restored. Tool-call arguments need the separate
  `privacy.restoreToolArguments` opt-in. Reasoning blocks, signatures and encrypted fields are never touched.

## Statistics and management

`src/privacy/stats.ts` keeps an in-memory ring of the most recent 2000 requests that had at least one
redaction. A record holds the kind, a count and the placeholder hash, never an original value or a prefix
of one. `src/server/management/privacy-routes.ts` serves `/api/privacy/stats`, `/api/privacy/config`,
`/api/privacy/test` and `/api/privacy/allow-values` under the
[management API](gui-and-management-api.md) authentication.

Coverage: `tests/server/privacy-redaction.test.ts`, `tests/server/privacy-restore.test.ts`,
`tests/server/privacy-e2e.test.ts` and `tests/claude-integration/claude-intercept-privacy-redaction.test.ts`.
