# Vendored: @magpie-community/opencode-agy-cli-auth

- Upstream package: `@magpie-community/opencode-agy-cli-auth`
- Version: 0.1.49 (`.bun-tag` sha512 in the source package)
- License: MIT. Copyright (c) 2026 DylanLIiii, Copyright (c) 2026 gitxm, Copyright (c) 2026 yce. Full text in `LICENSE`; provenance in `NOTICE.md`.
- Source path: `~/.config/magpie/plugins/node_modules/@magpie-community/opencode-agy-cli-auth/`
- Vendored: 2026-11-14

## Files

Copied: `index.mjs`, `platform.mjs`, `login.mjs`, `mcp-server.mjs`, `step-usage.mjs`, `tool-schema.mjs`, `tool-budget.mjs`, `usage.mjs`, `signin.mjs`, `re2-pattern.mjs`, `array-items.mjs`, `cloak.mjs`, `LICENSE`, `NOTICE.md`.
Not copied: `opencode.mjs`, `opencode2.mjs`, `README*`, `package.json`, `.bun-tag`.
Added here: `index.d.mts` (declaration for the factory export).

Every relative import resolves inside this directory.

## Patches

Line numbers refer to the vendored copy as of 2026-11-14.

1. All `.mjs` and text files: CRLF converted to LF, to match the repo's `.gitattributes` (`* text=auto eol=lf`). Whitespace only.
2. `index.mjs` 20-26: wrap the module body in `export function createAgyBridge(options = {})`, with per-instance `agyEnv`, `agyHome`, `agyPathOption`, `stateFileOption`, `withAgyEnv`, and `spawnAgyHere`. The body is not reindented. Reason: the factory makes every module-level `let`, `const`, `Map`, class and timer per instance.
3. `index.mjs` 34, 35, 1008, 2491, 5738: remove `export` from `MIN_AGY_VERSION`, `agyTooOld`, `ideToolOf`, `IMAGE_FOLLOWS`, `AntigravityBridgePlugin`. Reason: exports are not allowed inside a function body.
4. `index.mjs` 191-192: `findAgy()` returns `options.agyPath` when set. Reason: explicit executable, skips discovery and `AGY_PATH`.
5. `index.mjs` 216, 418, 1657: agy child spawns use `spawnAgyHere`, which merges `options.env` over the child environment. Reason: every agy child of an instance gets the instance env. The `taskkill` path stays on plain `spawn`.
6. `index.mjs` 2051: `sessionDbPath(this.sessionId, withAgyEnv(process.env), agyHome)`. Reason: conversation DB lookup uses `options.home`, not `os.homedir()`.
7. `index.mjs` 2622: `sessionStateFile()` returns `options.stateFile` before `AGY_BRIDGE_STATE_FILE`. Reason: instances must not share the bridge state file, even when the env var is set.
8. `index.mjs` 2821: `const evictTimer = setInterval(...).unref()`. Reason: `shutdown()` clears the timer.
9. `index.mjs` 5739: `createUsageReader(findAgy, { env: withAgyEnv(process.env) })`. Reason: the usage probe spawns agy and must get the instance env.
10. `index.mjs` 5766: `startLogin(agy, { env: agyEnv })`. Reason: sign-in spawns agy with the instance env.
11. `index.mjs` 5822-5823: the keyring sign-in gate is skipped when `options.env` is set. Reason: in file-token mode the per-account token file is managed by OCX, and the global keyring says nothing about it.
12. `index.mjs` 6096-6106: `export { sanitizeInputSchema }` and `export default` replaced by the factory return value. `fetch` lazily calls `AntigravityBridgePlugin()` and then `auth.loader()` on first use, so `createAgyBridge` stays synchronous. `shutdown()` clears the eviction timer, removes this instance's exit hook, runs `reapOnExit()`, and closes the control server. Reason: the required interface.
13. `login.mjs` 36, 44: `startLogin` accepts `env` and passes it to `spawnAgy`. Reason: login child gets the instance env.
14. `step-usage.mjs` 71, 76: `conversationsDir` and `sessionDbPath` take an optional `home` (default `os.homedir()`). Reason: see patch 6.
15. `index.mjs` `Proc`: `start()` is split into `#launch()` (workspace, spawn, ACP connection), `#guardStart()` (the start timeout), `#initialize()` (capabilities) and `#openSession()` (resume or `session/new`, model, tool list); the per-conversation constructor fields move to `#assign()`. New `warm()` launches, initializes and opens and closes one throwaway session, and `adopt(convKey, opts)` assigns a conversation to a warmed process and opens its session. Reason: agy spends about a second booting its backend on a process's first `session/new`; a warm process skips that and the spawn.
16. `index.mjs` next to `retire()`: one warm spare `Proc` per bridge instance (`spare`, `refillSpare`, `takeSpare`, `discardSpare`). `acquireProcLocked` adopts the spare when its agyPath and workDir match, falls back to a cold start only when the spare died, frees the spare's slot before evicting live work at the process cap, and refills the spare after every new process. `evictIdle` discards a spare idle past `IDLE_MS`. The session log row gains `warm`. `AGY_BRIDGE_SPARE=0` turns it off. Reason: a new conversation no longer waits for a process to start.
17. `index.mjs` factory return: `dropSpare()` stops the spare (OCX calls it after rewriting the account's token file); `shutdown()` stops the spare and blocks refills first. Reason: a spare must not outlive a credential change or the bridge.

## Left as upstream, with per-instance consequences

- `login.mjs` keeps a module-level `pending` login. Starting a sign-in on one instance stops a pending sign-in on another.
- `signin.mjs` keeps module-level caches (stored sign-in, dead sign-ins). They describe the global keyring, so sharing them is intended.
- `backgroundBlocked()` (model listing, sign-in probe) and the usage reader's default `signIn` still read the global keyring even in file-token mode. Under file-token mode, model listing can be blocked and usage reported as expired.
- `THINKING_KEY` and `HOST_EPOCH` are per instance. No verification of thinking signatures was found in `index.mjs`, so this changes no visible behaviour.
- Each instance registers its own `process.once("exit", reapOnExit)`. Node warns above 10 listeners on `exit`.
- The Windows nc build (`windowsNcDir`) goes through `execOnce`, so it also gets the instance env. It runs once per machine.
