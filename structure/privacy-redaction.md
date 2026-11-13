# Client-Request Privacy Redaction

`privacy.enabled` turns on redaction of the client's original request body before any routing,
translation or combo dispatch reads it. Default off; the config fields live in
`src/types/privacy-redaction-config.ts` and the engine in `src/privacy/`.

## Where it is mounted

- Responses: `prepareResponsesRequest` in `src/server/responses/request-prepare.ts`, right after the
  body is decoded. Every downstream path (combo child dispatch, direct and native lanes) continues
  from the reassigned body.
- Chat Completions: `src/server/chat-completions.ts`.
- Anthropic Messages: `src/server/claude-messages.ts`, before the native passthrough, and the
  `count_tokens` native passthrough.
- The Claude Code intercept relay-native lane (`api.anthropic.com`), including Claude Code processes
  spawned by Claude Desktop.

A redaction error fails closed: the request is answered 503 and the original body never reaches a
vendor. Redaction does not cover the Claude Desktop picker's `claude.ai:443` relay; that is Desktop's
own first-party chat, relayed unchanged.

## What it replaces

`redactClientBody` (`src/privacy/redact.ts`) replaces secrets with `{{SECRET_xxxxxxxx}}`
placeholders. `privacy.allowValues` lists exact originals that stay untouched. Code identifiers,
`*_tokens` usage counters and `prompt_cache_key` are not masked.

## Optional modes

- `restoreResponses` (two-way): `applyPrivacyRestore` (`src/privacy/restore.ts`) maps placeholders a
  model echoes back to the originals, only for the request that sent them. Wired in
  `src/server/responses/core.ts` and `src/server/claude-messages.ts`. `restoreToolArguments` extends
  it to tool-call arguments.
- `revealValues`: originals are kept in process memory only, listed by `GET /api/privacy/values`.
  Never written to disk or logs. Each listed value carries its allow-list `id` and the `requestIds`
  that carried it, so the dashboard shows it under its request and "Not a secret" posts it to
  `allow-values` (undone by deleting that same `id`). Turning the mode off drops the originals.

## Stats and management

`src/privacy/stats.ts` records hit counts, never values. The row is written before routing settles,
so `addFinalRequestLog` in `src/server/request-log.ts` backfills the real provider and model.
`src/server/management/privacy-routes.ts` serves `/api/privacy/{stats,config,test,allow-values,values}`;
the dashboard page is `gui/src/pages/Privacy.tsx`.

Request redaction (`privacy.enabled`) does not cover the picker's `claude.ai:443` relay. That traffic is Desktop's own first-party chat in a private claude.ai format; the relay streams request bodies unchanged and only rewrites the bootstrap response. Redaction covers the Responses, Chat and Messages entry points and the Claude Code `api.anthropic.com` intercept path (including Claude Code processes spawned by Desktop). Sensitive content belongs in the Code tab with an OpenCodex model, not in the claude.ai chat box.

