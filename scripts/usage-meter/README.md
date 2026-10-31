# OpenCodex local usage meter

Created: 2026-10-25 · Updated: 2026-10-25 · Version: 0.1.0

A read-only local meter for traffic passing through OpenCodex, including third-party routes. It reuses the ledger scanner, session hashing, cache provenance, generation-rate calculation, attempt pricing and summary accumulator from this checkout. It neither starts the proxy nor changes its configuration or credentials.

## Run

From the OpenCodex checkout with its existing Bun dependencies installed:

```sh
bun scripts/usage-meter/server.ts serve
```

Open `http://127.0.0.1:18082/` in the Codex browser panel. `CODEX_THREAD_ID` selects the launch chat by default; `METER_CONVERSATION` overrides it. A URL such as `/?conversation=<thread-id>` selects another conversation explicitly. Switching the host chat does not automatically retarget a panel.

`METER_PORT` changes the loopback-only port. `METER_TIMEZONE` defaults to `America/New_York`; this sets only this process's timezone. `OPENCODEX_HOME` retains its normal OpenCodex meaning. The process has no startup registration; stop it with Ctrl+C or stop the specific launcher process. It opens no native window itself.

For a machine-readable snapshot, use `bun scripts/usage-meter/server.ts snapshot`. The initial scan reads complete ledger history cooperatively; further checks consume only appended complete rows. Two panel conversation views are cached, with scans serialized and inactive views no longer refreshed. Rotations, rewrites and truncation rebuild the derived state. No secondary ledger or credential store is created.

## Local MCP

`bun scripts/usage-meter/mcp.ts` exposes the read-only `read_usage` tool over stdio. Its optional `conversation_id` accepts a thread ID, the persisted digest, or a Codex thread link. Without it the tool reports this machine's global traffic. It does not guess which host chat is active. Use the panel URL in the result only while the HTTP meter is running.

`bun scripts/usage-meter/package-local.ts` produces a private marketplace package under the user's `.agents/local-marketplaces/opencodex-meter/` directory. Pass a destination as its first argument to use a different local directory. The generated stdio command points to this checkout. It does not upload the ledger or publish a cloud plugin. Local source and the Bun runtime must remain available.

Register that generated marketplace with `codex plugin marketplace add <generated-directory>`, then install `codex plugin add opencodex-meter@opencodex-meter-local`. New chats can load the bundled skill and MCP tools. Use the host's `codex plugin remove` / `codex plugin marketplace remove` commands to uninstall; no manual edits to the host configuration are needed. `open_meter` starts a detached meter with `windowsHide: true` when needed, or reuses the existing verified meter listener.

## Interpretation

- Generation throughput is an **estimate** over `genStartMs..lastOutputMs`, including reported reasoning output. Legacy first-output timing is explicitly qualified. End-to-end throughput includes waiting. Windows shorter than one second have no displayed decode estimate. Failed, incomplete and canceled requests never display successful throughput.
- Cache hit rate uses **observed** cache reads only. Unknown and synthesized zero telemetry remain unavailable. Cached tokens and reasoning tokens are subsets; neither is added again to input+output totals.
- Costs use existing OpenCodex configured provider rates first, then its catalog/expected prices. Attempts are priced individually. Summaries show their priced portion and coverage; unknown amounts are never rendered as zero. Subscription/API-equivalent estimates are distinct from actual cash charges, which are not available. Restart the meter after changing provider prices to rebuild historical estimates.
- Counts and costs reuse the canonical request/attempt aggregation contract. Cumulative session tokens include repeated context sends and are not the current context-window occupancy. Direct traffic and other machines are outside the ledger's scope.
- The ledger is written when a request finishes. Two-second refresh is **completion-level updating**, not instantaneous token-by-token speed. The page never claims the current request is generating when it has only a previous completed record.
- HTTP binds only to `127.0.0.1`. Requests validate Host/Origin and reject cross-site fetches; no CORS grant exists. Output is an allowlist of metering facts, excluding raw usage extensions, errors, account/key identifiers, prompts and credentials.

The supported integration is a Codex browser side panel plus local MCP tools. This does not add a control to the native composer footer. Official plugin tool support is not evidence of an arbitrary native UI insertion slot.

## Validation

```sh
bun test ./scripts/usage-meter/core.test.ts
bunx tsc --ignoreConfig --noEmit --target esnext --module esnext --moduleResolution bundler --types bun-types --strict --skipLibCheck scripts/usage-meter/server.ts scripts/usage-meter/mcp.ts scripts/usage-meter/package-local.ts scripts/usage-meter/core.test.ts
```

The repository's normal source typecheck remains separate because its tsconfig includes only `src/`. Test fixtures use an isolated temporary `OPENCODEX_HOME`; they do not write to a real ledger.
