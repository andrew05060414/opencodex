---
title: Model Ordering
description: How opencodex determines model order in the Codex picker and spawn_agent model overrides.
---

The Codex model picker does not preserve the order of provider declarations or model arrays in the
opencodex configuration. Its final order comes from catalog priorities, with a deterministic
alphabetical order for routed models that share the same priority.

## The rule Codex applies

Codex's models-manager sorts picker-visible catalog entries by `priority` in ascending order. It
discards the catalog array order, so moving an entry earlier in a generated JSON array does not move
it earlier in the picker. The implementation records this constraint directly in
`src/codex/catalog/sync.ts`.

Since PX-1276, `subagentModels` no longer overwrites catalog `priority` (`0` through `4`) or forces
subagent picks to the top of the global picker. Instead, the proxy rewrites the outbound
`spawn_agent` tool description on both V1 and V2 collaboration surfaces so `spawn_agent` advertises
the eligible configured `subagentModels` while the global picker preserves natural priorities or your
`modelPickerOrder`.

Without complete-picker ordering, the relevant no-selector priorities are:

| Catalog entry | Priority | Source |
| --- | ---: | --- |
| Ordinary routed models | `5` | Routed entry creation in `src/codex/catalog/sync.ts` |
| Routed models listed in `modelPickerOrder` (routed-only mode) | `1000 + i` | Display-only picker rank in `src/codex/catalog/sync.ts` |
| Native GPT slugs | `sourcePriority` (fallback `9`) | Shared native source-priority resolver |

Native source priority comes from the current discovered descriptor, then the pristine catalog
backup, then the same model's retained source value, then the upstream snapshot. Each candidate
must be an integer from `0` through `1000`; invalid values are skipped and the final fallback is
`9`. Published display priorities are never reused as source priorities. The live Codex model list,
published catalog and models cache use the same priorities for the same inputs. Account-selector
groups retain their separate stride policy; complete-picker ordering remains the final override.

The management API limits `subagentModels` to five entries with `slice(0, 5)` in
`src/server/management/agent-settings-routes.ts`. This matches the Codex `spawn_agent` surface, which
advertises only the first five model overrides. Models outside those five can still remain visible
in the main picker and callable by their exact id.

## How ties are ordered

All ordinary routed models have priority `5`, so they need a tie-breaker. Before catalog entries are
built, `gatherRoutedModels()` sorts the routed model list by provider name and then by model id, both
alphabetically (`src/codex/catalog/provider-fetch.ts`).

This means neither of these configuration details changes the final order:

- the declaration order of keys in the `providers` object;
- the order of ids in a provider's `models` array.

## Visibility is separate from ordering

`selectedModels` and `disabledModels` decide which routed models are exposed; they are not ordering
controls. `filterCatalogVisibleModels()` converts both selections to `Set` lookups and filters the
gathered list without using the arrays as ranks (`src/codex/catalog/provider-fetch.ts`).

As a result, reordering `selectedModels` or `disabledModels` has no effect on picker position. It can
only change whether a model is included.

## Effective picker pattern

Without `modelPickerOrder`:

1. All routed models appear at priority `5`, ordered alphabetically by provider and then model id.
2. Native GPT entries appear according to their normal source priority (fallback `9`).

Configuring `subagentModels` no longer pushes those picks ahead of other routed or native entries in
the global picker; it controls the overrides advertised in `spawn_agent` on the wire (when
`multiAgentGuidanceEnabled` is enabled and catalog state is not `stale` or `unknown`).

## Example

Suppose `subagentModels` contains these five ids in this exact order:

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

With no `modelPickerOrder` configured, global picker priorities stay unaffected:

| Picker group | Model | Priority | Why it appears there |
| --- | --- | ---: | --- |
| Routed models | `anthropic/claude-opus-4-6`, `opencode-go/glm-5.2`, ... | `5` | Provider alphabetically, then model id alphabetically |
| Native models | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, ... | `sourcePriority` (fallback `9`) | Native source order |

Meanwhile, `spawn_agent` advertises the five `subagentModels` entries in their configured order via
the outbound wire rewrite. With account selectors, bare native choices expand into selector-qualified
groups while remaining capped at five advertised entries.

## Changing the order

Use `subagentModels` to choose and order the overrides advertised to `spawn_agent`. The dashboard's
**Sub-agents** page can reorder bare native and routed ids. Use `ocx agent subagents set` or edit
the opencodex configuration for exact `<selector>/<native-openai-model>` choices; the dashboard
retains those ids once saved, including choices currently unavailable. Use at most five configured
ids. With account selectors, one bare native choice can expand into multiple selector-qualified
catalog rows, so configured choices and advertised rows are not necessarily one-to-one.

If no configured account supports an account-gated native model, the request fails as an invalid
model choice. If supporting accounts exist but are temporarily exhausted or unavailable, it fails
as a retryable rate limit. These states are never reported as an invalid API key; choose another
available model or wait for the capable account's quota window to reopen.

Use `modelPickerOrder` for display-only ordering of routed `<provider>/<model>` rows:

```json
{
  "modelPickerOrder": [
    "tyler/deepseek-v4-flash",
    "jd-chat/kimi-k3",
    "jd-chat/glm-5.2"
  ]
}
```

Listed routed rows appear in the configured order (`1000 + i`). A routed row omitted from the array
keeps its normal priority (`5`), so it remains ahead of the `modelPickerOrder` display band; list
every routed row whose relative position you want to control. With a routed-only list, native rows
keep their normal positions.

To order the complete picker, include a bare native id:

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

Listed rows appear first in array order, followed by unlisted rows in natural priority
order. Matching uses exact catalog ids: `gpt-5.6-sol` and `openai/gpt-5.6-sol` are separate
rows. Raw and encoded spellings of the same routed id are also accepted, with exact
matches taking precedence. Empty entries are ignored. Account-qualified rows need
their selector-qualified id in the list.

### Migration note: native ids in existing orders

Previously, native ids in `modelPickerOrder` were ignored. An existing list containing
a bare native id now activates complete-picker ordering across native and routed rows.
Remove bare native ids to keep the previous routed-only behavior. Unset, empty and
routed-only lists retain their behavior; OpenCodex's natural-priority guidance candidate calculation is unchanged.

`modelPickerOrder` preserves OpenCodex's calculation of up to five `spawn_agent` candidates from
`subagentModels`. Changing picker display order does not change what `spawn_agent` advertises on
either V1 or V2 when the outbound rewrite is active. Exact-name override lookup also remains
unrestricted by the advertised list; existing authentication, model/effort and backend constraints
still apply.

`disabledModels` and each provider's `selectedModels` remain visibility fields,
not ordering controls. There is no separate `modelOrder`, `providerOrder`, or priority-map setting.

## Dashboard picker presets

On **Models**, choose **Default**, **A–Z by model**, **Group by provider**, or **Most used snapshot**, then **Apply order**. This saves the currently visible native and routed ids and `modelPickerOrderMode` (`alphabetical`, `provider`, or `most-used`). Most used reads all retained usage once when applied; reloads restore the snapshot without fetching usage again. New or removed models do not automatically recompute it. Default clears both picker fields, even when no visible models are available.

The controls use `GET/PUT /api/subagent-models`: `chosen` and `available` retain saved roster choices, including disabled or missing models; `pickerAvailable` contains the visible bare native and routed catalog ids that `PUT` accepts. The Models page sends `pickerOrder` and `pickerOrderMode`, never `models`. Roster-only saves preserve picker settings. Invalid combined updates and failed persistence leave the previous picker/roster state intact.

When the saved order includes bare native ids, Codex applies complete-picker display ordering while Claude discovery still reorders only its routed groups and keeps native prefixes and explicit Desktop profile/alias ownership unchanged. OpenCodex guidance ranks, `spawn_agent` overrides, and configured fallback settings are preserved. Saving does not restart clients; a catalog refresh may remain pending, and clients holding an old catalog may need reopening.

### Custom mixed order

Choose **Custom order** on Models to load a fresh snapshot containing both visible native and routed models in one unified list. Drag any row before another row, or use its Up/Down buttons, then **Save draft**. Bare native ids are shown verbatim (marked as Native) and matched exactly without alias guessing. Surviving saved rows keep their relative order and new candidates follow the current candidate list. Every save sends the complete visible list without changing the subagent roster, and saved orders that include native ids remain directly editable on reload.

Before saving, the editor checks a fresh snapshot; changes preserve your draft and block saving until **Reload and discard draft** loads current settings. Request failures retain the draft. Accepted saves can still have a pending catalog refresh; reload before editing again.

The editor still requires an unambiguous model identity for every routed candidate. If the routed model catalog is incomplete or ambiguous, refresh the Models page before editing; reloading picker settings alone cannot restore missing catalog identities. Featured choices (`subagentModels`) do not lock or pin rows in the editor.
