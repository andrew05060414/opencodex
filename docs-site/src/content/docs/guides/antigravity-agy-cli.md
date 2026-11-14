---
title: Antigravity via the agy CLI
description: Send google-antigravity requests through Google's official local agy CLI while keeping the OpenCodex account pool.
---

By default OpenCodex calls Google's Antigravity API itself. With the agy transport, each
`google-antigravity` request instead leaves through Google's official `agy` CLI, driven over the
Agent Client Protocol (`agy acp`). The account pool, rotation, quota handling and dashboard
status stay the same; only the sender changes. The direct transport remains the default.

## Requirements

- `agy` is installed and on `PATH`, or its path is set as `agyTransport.agyPath`.
- The accounts are already in the OpenCodex Antigravity pool. No separate agy sign-in is needed:
  OpenCodex gives each pool account its own agy home under `<OpenCodex home>/agy-homes/` and
  writes that account's token there.

## Turning it on

For every request, in `config.json`:

```json
{ "providers": { "google-antigravity": { "agyTransport": { "enabled": true } } } }
```

For one client, send the request header `x-opencodex-antigravity-transport: agy` (or `direct` to
opt out while the config flag is on):

- Claude Code: `ANTHROPIC_CUSTOM_HEADERS="x-opencodex-antigravity-transport: agy"`
- Codex: add the header to the provider's `http_headers` in `config.toml`

## What to expect

- Client tools still run in the client. agy's own tools are disabled; the client's tools reach the
  model through a local MCP bridge and come back as ordinary tool calls.
- The first request of a conversation waits several seconds while agy starts. Later turns reuse
  the same agy process, which is reclaimed after ten idle minutes.
- When an account runs out of quota, the request moves to the next pool account, as on the direct
  transport.
