# 后端有、仪表盘藏着的功能：盘点与上游 issue 草稿

> 创建日期：2026-11-21 ｜ 最后更新：2026-11-21 ｜ 版本：1.0 ｜ 票：PX-1450（母票 PX-1446）

## 结论（先看这里）

- 配置类型里一共 330 个字段（`OcxConfig` + `OcxProviderConfig`），以上游 `upstream/dev`（`572e65cd7`，2026-11-21）为准，**224 个在 `gui/src` 里一次都没出现过**。这只是按名字搜的上限：有的字段经管理接口改了名字后有入口（下文「已有入口」一节列了 9 个这样的例子），所以真正藏着的少于 224 个。下文主表里的每一条都按功能另外核实过。
- 票面里四个例子，三个已经过时：Vertex 免 key 上游已修好（#8311），协议直通/转换已经能看到（日志徽章 + 方案面板），`visionSidecar` 和 Lab 矩阵都已有入口。**真正还藏着的高价值项是：供应商改名、超时与重试、账号池缓存亲和与切换阈值。**
- fork `dev-2.93` 落后上游 692 个提交。Vertex 修复、`transientRetryOn5xx` 的界面、按供应商设超时都只在上游有。**fork 同步一次上游，就能直接拿到其中几项，不用自己写。**
- 上游 issue 草稿 4 份，见文末，**还没提交，等 Andrew 同意**。其中第 4 份是更深一层的做法：不再一个开关一个开关地补，而是按配置类型的注释自动生成一个「高级设置」页，把长尾一次性收进去。

## 方法与局限

1. 从 `src/types/config.ts` 的 `OcxConfig`、`src/types/provider.ts` 的 `OcxProviderConfig` 取出所有顶层字段（脚本按花括号深度解析）。
2. 对每个字段，在 `gui/src` 里按整词 `git grep`（排除 `i18n/` 和测试），`origin/dev-2.93` 和 `upstream/dev` 各跑一遍。
3. 对候选项再按功能搜：管理接口路径（如 `/api/codex-auth/failover`）、DTO 改过的名字、相关组件，确认界面确实没有入口。
4. 局限：
   - 名字级扫描会有假阳性（字段经接口改名后其实有入口），所以附录里的全量清单**没有逐条核实**，只有主表核实过。
   - 解析器会漏掉少数跨行声明的字段。
   - 不包括 CLI 独有的能力，也不包括没有落到配置字段的运行时开关。
   - 「有没有入口」只看源码，没有打开实际页面点过。
5. 「JSON 编辑器」是兜底：仪表盘有整份配置的 JSON 编辑（`gui/src/hooks/useJsonConfigEditor.ts`），所以下文的「没有入口」指的是**没有专门的控件**，改 JSON 仍然可以开。

## 一、票面例子的现状（纠正之前猜的那张表）

| 例子 | 现状 | 证据 | 要做什么 |
|---|---|---|---|
| Vertex 用 gcloud 凭据免 key | **上游已修**：#8156 于 2026-11-08 关单，修复在 #8311（`5279c91bf0`）。fork `dev-2.93` **没有**这个提交 | `git merge-base --is-ancestor 5279c91bf0 origin/dev-2.93` → 不是祖先；后端 `src/adapters/google-vertex-endpoint.ts:32-37` | fork 同步上游，不再提 issue |
| 供应商不能改名 | **仍然没有入口**。后端批量接口已支持改名 | 见主表 H1 | 草稿 1 |
| 协议直通还是转换看不到 | **大部分已能看到**：日志行有协议徽章，API Keys 页和组合详情有协议方案面板，供应商页有原生直通开关 | `gui/src/pages/Logs.tsx:16`（ProtocolBadge）、`gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:574`（ProtocolPlanPanel）、`gui/src/components/combo-workspace-detail-panel.tsx:424`、`gui/src/components/provider-workspace/NativePassthroughSetting.tsx` | 剩下的是 `protocols.rollout` 几个灰度开关，见主表 M1 |
| `visionSidecar` 没入口 | **已有入口**：Claude Code 页的视觉旁路设置，组合里可以指定旁路目标 | `gui/src/pages/claude-code-sections.tsx`、`gui/src/combo-workspace-data.ts:522-546` | 无 |
| 缓存亲和没入口 | **仍然没有入口** | 见主表 H3 | 草稿 3 |
| Lab 没入口 | **兼容性矩阵已有入口**；Lab 自动化（定时跑测试）没有 | `gui/src/pages/compatibility-matrix-api.ts:79` 调用 `/api/lab/*`；`src/server/management/lab-automation-routes.ts:81,85,119,163` 的 `/api/lab/automation*` 在 `gui/src` 里搜不到 | 主表 M8 |

## 二、主表：核实过的隐藏功能（以上游 `upstream/dev` 为准）

价值按 Andrew 的实际用法评：供应商多、用 Antigravity 和 Codex 账号池、用组合、在 Windows 上跑。「fork」列只在 fork 和上游不一样时才写。

| # | 字段或能力 | 作用（白话） | 后端位置 | 前端现状 | 价值 | fork |
|---|---|---|---|---|---|---|
| H1 | 供应商改名 | 把供应商 `foo` 改叫 `bar`，模型、组合引用跟着走 | `PUT /api/providers`（baseline/next 批量编辑，`src/server/management/provider-routes.ts:1025`）；CLI `ocx provider batch apply` 明确支持改名（`src/cli/provider-batch.ts:56`） | `gui/src` 里没有任何地方调用 `PUT /api/providers`；只有组合能改名（`combo-workspace-data.ts:522` 的 `renameFrom`） | 高 | 同 |
| H2 | 上游超时：`stallTimeoutSec`、`connectTimeoutMs`（全局 + 按供应商） | 多久没数据算卡死、多久连不上算失败；Antigravity 这类慢的线路最需要调 | `src/types/config.ts:1083,1092`；按供应商覆盖 `src/types/provider.ts:363,370`；实现 `src/stall-timeout.ts`、`src/lib/pinned-http.ts:151` | 只在日志的失败原因里显示「连接超时 / 卡住超时」（`gui/src/pages/logs-failure-summary.ts:133,142`），没有地方能改 | 高 | 按供应商覆盖只在上游有 |
| H3 | 重试策略：`retryOn429`、`retryOnReset` | 被限流（429）时同一个 key 等一下再发；连接被重置时自动重发 | `src/types/provider.ts:1189,1201`；实现 `src/providers/key-failover.ts:292-308`、`src/lib/upstream-retry.ts` | 搜不到。同一组里的 `transientRetryOn5xx` 上游已经有界面（`gui/src/provider-workspace/target-drafts.ts:153`），这两个没跟上 | 高 | fork 连 5xx 那个界面也没有 |
| H4 | 账号池 `pool.cacheAffinity` / `pool.kernel` / `pool.credentialGroups` | 缓存优先还是额度优先选账号（影响 prompt cache 命中和 token 花费）；通用 OAuth 账号池内核；凭据分组 | `src/types/config.ts:1278,1301,1324`；`src/codex/routing/selection.ts:370`、`src/codex/routing/cache-affinity.ts` | 三个名字在 `gui/src` 里都是 0 次 | 高（上游 #4546 就是缓存被打爆、token 烧 10~50 倍） | 同 |
| H5 | `upstreamFailoverThreshold` | 上游连续失败几次后，新会话改走别的账号（默认 3，0 = 关） | 字段 `src/types/config.ts:1346`；**管理接口已经写好**：`PUT /api/codex-auth/failover`（`src/codex/auth-api/routes.ts:409-416`） | 仪表盘从没调用过这个接口（`codex-auth/failover` 在 `gui/src` 里 0 次）——接口写了，但没接到界面上 | 高（成本最低） | 同 |
| M1 | `protocols.rollout.*`（`directEncoders`、`antigravityDirect`、`nativeChatCombos`、`shadowPlan`）和 `protocols.unrepresentable` | 各条原生直通路径的灰度开关；遇到没法转换的字段是报错还是退回旧路径 | `src/types/config.ts:700`；`src/protocols/settings.ts:87-114` | 只有 Gemini/Antigravity 原生直通一个开关（`NativePassthroughSetting.tsx:74`），其余灰度开关都没有 | 中 | 同 |
| M2 | `blockedModelRedirects` | 把被封或下线的模型 id 自动改发到替代模型 | `src/types/config.ts:965`；`src/server/responses/core-combo.ts:171,865` | 0 次 | 中 | 同 |
| M3 | `modelAdapters`（按模型换协议） | 同一个网关下，个别模型走 Responses、其余走 Chat | `src/types/provider.ts:385`；`src/providers/fastwire.ts:176` | 0 次 | 中 | 同 |
| M4 | 按模型的兼容开关：`reasoningEffortMap`、`thinkingToggleModels`、`thinkingBudgetModels`、`noTemperatureModels`、`noStopModels`、`noStructuredOutputModels` 等十几个 | 第三方网关不认某个参数就 400，这些开关负责去掉或改写 | `src/types/provider.ts:1011-1236` | 0 次（`thinkingBudget` 只在调试面板里显示数值） | 中 | 同 |
| M5 | 模型上限：`modelMaxOutputTokens`、`defaultMaxOutputTokens`、`modelMaxInputTokens`、`modelAutoCompactTokenLimits`、`modelCapabilities` | 按模型设输出/输入上限、自动压缩阈值、能力声明（图片、推理） | `src/types/provider.ts:749-765` | 0 次 | 中 | 同 |
| M6 | 固定推理档：全局 `modelPinnedEfforts`，按供应商 `pinnedReasoningEffort` / `modelPinnedReasoningEfforts` | 不管客户端选什么，都强制用某个推理档 | `src/types/config.ts:864`；`src/types/provider.ts:885,887` | 只有推理档上限（`/api/effort-caps`，`dashboard-overview-sections.tsx:80`），没有「固定」 | 中 | 同 |
| M7 | `cacheRetention` | Anthropic prompt cache 存 5 分钟还是 1 小时，或者关掉 | `src/types/config.ts:1169`；`src/adapters/anthropic/cache-retention.ts` | 0 次 | 中 | 同 |
| M8 | Lab 自动化 `/api/lab/automation*` | 定时自动跑兼容性测试、看历史结果 | `src/server/management/lab-automation-routes.ts:81-163` | 矩阵页只读结果，没有自动化的设置和触发入口 | 中 | 同 |
| M9 | `quotaResetNotify`、`resetCreditAutoRedeem` | 额度重置时提醒；Codex 重置券快过期时自动兑换 | `src/types/config.ts:1003,1268`；`src/quota/reset-notify-config.ts`、`src/server/index.ts:871` | 0 次 | 中 | 同 |
| M10 | `tokenGuardian` + 按供应商 `refreshPolicy` | 后台提前刷新 OAuth token，避免请求时才发现过期 | `src/types/config.ts:1444`；`src/oauth/token-guardian.ts:136` | 0 次 | 中 | 同 |
| M11 | 模型别名：`modelAliases`、`aliasTemplate` | 给长模型 id 起短名，或按模板 `{providerAlias}-{modelBasename}` 批量生成 | `src/types/provider.ts:336,342` | 0 次（显示名已有 `ModelDisplayNameDialog.tsx`，但它只改显示名，不改请求时用的别名） | 中 | `aliasTemplate` 只在上游有 |
| M12 | `newModelPolicy`、`retainModels` | 新发现的模型默认开还是关；上游 `/models` 列表漏掉的模型也保留 | `src/types/provider.ts:699,704` | 0 次 | 中 | 同 |
| M13 | `streamMode` | Windows/macOS 上 SSE 流的转发方式（#314 的缓解措施） | `src/types/config.ts:829` | 0 次 | 中（Andrew 在 Windows 上跑） | 同 |
| L1 | `codexFailureWindow`、`codexPinnedTransientPolicy`、`codexWsReuseAcrossTurns` | 失败率窗口；手动固定的账号变差时是继续用还是让新会话绕开；WebSocket 跨轮复用 | `src/types/config.ts:1351,1356,1358` | 0 次 | 低~中 | 同 |
| L2 | `catalogAutoRefresh` | 模型目录定时刷新（默认每小时） | `src/types/config.ts:1014`；`src/codex/catalog-auto-refresh.ts:241` | 0 次（搜到的只是日志页自己的自动刷新） | 低 | 同 |
| L3 | `openRouterRouting`、`vercelGatewayRouting`（含按模型） | 经 OpenRouter / Vercel 网关转发时，选哪家底层供应商 | `src/types/provider.ts:806-812` | 0 次 | 低（不用这两个网关就用不上） | 同 |
| L4 | `webSearchBridge` | 给不支持联网搜索的 key 型直通供应商桥接一个搜索 | `src/types/provider.ts:1002` | 0 次 | 低~中 | 同 |
| L5 | `emptyCompletionRetry`、`completeOnMaxOutputTokens` | 回复是空的就重试一次；输出被截断时也当成正常结束 | `src/types/config.ts:562,566` | 0 次 | 低 | 同 |
| L6 | `usageLedgerMaxBytes`、`codexProviderDisplayName`、`corsAllowOrigins` | 用量账本文件大小上限；Codex 里显示的供应商名；允许的跨域来源 | `src/types/config.ts:1115,1152,1446` | 0 次 | 低 | 同 |
| L7 | `upstreamHistorySlim` | 把历史里的旧图片和工具输出压短（有损） | `src/types/config.ts:1385`；系统接口只读地报告当前值（`src/server/management/system-routes.ts:153`） | 0 次 | 低 | 只在上游有 |

## 三、名字没搜到、但其实有入口（避免误报）

这些字段按名字搜不到，但核实下来有入口，**不要提 issue**：

| 字段 | 实际入口 |
|---|---|
| `subagentModelFallback` / `ByModel` / `PollMs` | 子代理页，走 `/api/subagent-model-fallback`（`gui/src/pages/Subagents.tsx:206,342`） |
| `routingProfiles` | 路由策略页（`gui/src/pages/RoutingProfiles.tsx`） |
| `modelDisplayNames` | 模型显示名对话框（`gui/src/components/ModelDisplayNameDialog.tsx`） |
| `creditCodexAccountIds` | 账号池里「额度用完后继续花 credits」开关，DTO 字段名是 `creditsAfterLimit`（`gui/src/codex-credit-spend.ts:10`） |
| `codexAccountPriorities` | 账号顺序预设（`gui/src/account-priority.ts`） |
| `codexAccountAutoSwitchThresholds` | 按账号设自动切换阈值（`gui/src/components/AccountAutoSwitchControl.tsx`） |
| `storageCleanupPolicy` | 存储页（`gui/src/pages/Storage.tsx:674`，`/api/storage/cleanup-policy`） |
| `apiKeyPool` | key 池管理走 `/api/providers/keys`（`gui/src/hooks/useProviderAccountPools.ts:800`） |
| `accountAutoPause` | 暂停原因和证据展示（`gui/src/account-pause-display.ts`）；策略本身仍然没有编辑入口 |

## 四、需要 Andrew 定的事

只有一件：**下面 4 份草稿要不要以他的名义提到上游 lidge-jun/opencodex**（这是以他名义对外，按规矩必须他点头）。推荐做法：

- 先提草稿 4（自动生成的高级设置页）。它一次能覆盖主表里的大部分中、低价值项，也最容易被维护者接受，因为不需要逐个设计控件。
- 草稿 1、2、3 是三个最影响日常使用的点，可以一起提，也可以等草稿 4 有回音再说。
- 不提也完全可以。票面说上游合不合都不管，这几项也能直接在 fork 里自己做（属于后续开发票，不在本票范围内）。

与此无关、不需要他定的建议：**fork `dev-2.93` 尽快同步一次上游**。Vertex 免 key、5xx 重试的界面、按供应商设超时都在上游，同步就能拿到。

---

## 附：上游 issue 草稿（按 `.github/ISSUE_TEMPLATE/feature_request.yml` 填写，未提交）

### 草稿 1 — Dashboard: rename a provider

- **Area**: Dashboard
- **What are you trying to accomplish?**
  I add providers quickly (often from a preset) and later want to give them a clearer name, e.g. `custom-1` → `ark-kimi`. I want to do that from the dashboard without hand-editing `config.json`.
- **What prevents this today?**
  The backend already supports it: `PUT /api/providers` takes a `baseline`/`next` provider snapshot and accepts renames (`src/server/management/provider-routes.ts`), and the CLI exposes this as `ocx provider batch apply --yes` (`src/cli/provider-batch.ts`: "Provider removals or renames require --yes"). The dashboard never calls `PUT /api/providers`, and the provider workspace has no rename action. Combos can already be renamed (`renameFrom`), so providers are the odd one out.
- **What should OpenCodex do?**
  The provider detail header gets a "Rename" action. After confirmation, the provider key changes, and references that are keyed by the provider name (combo targets, routing profiles, default provider, model selections) are either carried over or listed as "will break" before saving. OAuth accounts stored under the old name are either migrated or the dialog warns that they are not (the batch path documents that it does not do OAuth account cleanup).
- **Example usage or interface**
  Providers → `custom-1` → ⋯ → Rename → `ark-kimi` → the dialog lists "2 combos and 1 routing profile reference this provider; they will be updated" → Save.
- **Alternatives or workarounds**
  Edit `providers` in the raw JSON editor, or run `ocx provider batch apply`. Both silently leave dangling references.
- **Additional context**
  Found while auditing which config fields have no dashboard entry point.

### 草稿 2 — Dashboard: per-provider timeouts and retry policies

- **Area**: Dashboard
- **What are you trying to accomplish?**
  Some upstreams I use are slow or flaky (long first-token latency, occasional 429s, connection resets). I want to tune how long OpenCodex waits and whether it retries, per provider, from the dashboard.
- **What prevents this today?**
  All of this exists in config but has no control:
  `stallTimeoutSec` / `connectTimeoutMs` (global, `src/types/config.ts`, and per-provider overrides in `src/types/provider.ts`), `retryOn429` and `retryOnReset` (`src/types/provider.ts`). The Logs page already tells me a request failed with "connect timeout" or "stall timeout" (`gui/src/pages/logs-failure-summary.ts`), but offers no way to act on it. `transientRetryOn5xx` from the same family already has a provider control (`gui/src/provider-workspace/target-drafts.ts`), so the other two policies are just missing next to it.
- **What should OpenCodex do?**
  Provider settings get a "Network & retries" section with: connect timeout, stall timeout (inherit global / custom / off), 429 retry (off / on with max wait), reset replay (off / on), next to the existing 5xx retry control. The global defaults are editable in Settings. A failure row in Logs that says "stall timeout" links to that provider's section.
- **Example usage or interface**
  ```json
  "providers": { "antigravity": { "stallTimeoutSec": 600, "connectTimeoutMs": 45000, "retryOn429": {}, "retryOnReset": {} } }
  ```
  should be reachable as four controls on the provider page.
- **Alternatives or workarounds**
  Hand-edit JSON. It works, but nobody discovers these fields unless they read `src/types/provider.ts`.

### 草稿 3 — Dashboard: expose Codex pool routing knobs (cache affinity, failover threshold)

- **Area**: Authentication and account pool
- **What are you trying to accomplish?**
  I run several Codex accounts in the pool and want to choose between "keep a conversation on one account to keep the prompt cache warm" and "spread by remaining quota", and how fast new threads move off a failing account.
- **What prevents this today?**
  `pool.cacheAffinity`, `pool.kernel`, and `pool.credentialGroups` (`src/types/config.ts`; read in `src/codex/routing/selection.ts`) have no dashboard control. `upstreamFailoverThreshold` even has a finished management endpoint, `PUT /api/codex-auth/failover` (`src/codex/auth-api/routes.ts`), but the dashboard never calls it. #4546 shows what goes wrong when cache affinity is not what the operator expects.
- **What should OpenCodex do?**
  The account pool card shows: cache affinity (on / off, with one line on the trade-off), failover threshold (0–20, 0 = off, wired to the existing endpoint), and optionally the failure window and the pinned-account policy (`codexFailureWindow`, `codexPinnedTransientPolicy`).
- **Example usage or interface**
  Account pool → Routing → "Prefer cache (keep a thread on one account)" ☑ ; "Move new threads after [3] consecutive failures".
- **Alternatives or workarounds**
  Hand-edit JSON, or `curl -X PUT /api/codex-auth/failover`.

### 草稿 4 — Dashboard: schema-driven "Advanced settings" page for the long tail

- **Area**: Dashboard
- **What are you trying to accomplish?**
  Find and change an existing config option without reading the source, and see which non-default options are currently active.
- **What prevents this today?**
  A field-name audit of `OcxConfig` and `OcxProviderConfig` against `gui/src` found 224 of 330 fields never referenced by the dashboard (an upper bound; some are reachable through renamed DTOs). Many are small, well-documented compatibility switches (`noTemperatureModels`, `thinkingToggleModels`, `reasoningEffortMap`, `modelAdapters`, `blockedModelRedirects`, `cacheRetention`, `streamMode`, …). Giving each one a dedicated control does not scale, and today the only path is the raw JSON editor, which gives no hints about what exists.
- **What should OpenCodex do?**
  An "Advanced" page (global, plus a tab on each provider) is generated from the existing zod schema and the JSDoc on the config types. It lists every documented field with its description and type. It highlights the fields currently set to a non-default value, and edits them through the same `validateConfigCandidate` write boundary the JSON editor uses. Fields marked internal (migration markers, revisions, runtime-only like `_apiKeyAttempt`) are excluded by an explicit allow/deny list, not by guessing.
- **Example usage or interface**
  Settings → Advanced → search "temperature" → `providers.<name>.noTemperatureModels` — "Model ids that reject caller-specified temperature." → add `grok-4.6` → Save (validated server-side).
- **Alternatives or workarounds**
  The raw JSON editor (no discoverability, no per-field help), or one-off controls per field (doesn't scale).
- **Additional context**
  The descriptions already exist in `src/types/config.ts` and `src/types/provider.ts`, so the page needs no new copy except section titles. Locale handling: field descriptions could stay English (technical text), with only the page chrome in i18n.

---

## 附录：名字级扫描全量清单（未逐条核实）

由本票的扫描脚本生成（脚本未入库）：上游 `upstream/dev` 里在 `gui/src`（不含 i18n、测试）中整词出现 0 次的字段，共 224 个。主表和第三节没提到的，大多是内部标记（迁移版本号、修订号、运行时字段）或者很窄的兼容开关。

<details><summary>展开 224 个字段</summary>

| 字段 | 上游位置 | 说明（类型注释原文节选） |
|---|---|---|
| `OcxConfig.chatgptDesktop` | `src/types/config.ts:539` | Experimental macOS app-server stdout shim; absent or false disables it. |
| `OcxConfig.runtimeRole` | `src/types/config.ts:542` | Runtime topology role. Absence preserves the historical standalone behavior. |
| `OcxConfig.remoteGui` | `src/types/config.ts:546` | Opt-in remote dashboard issuance policy. Presence is inert outside the hub role. |
| `OcxConfig.metricsExport` | `src/types/config.ts:554` | Opt-in process-local aggregate request metrics on the authenticated management plane. |
| `OcxConfig.serviceHealthRecovery` | `src/types/config.ts:560` | Opt-in recovery of a managed service proxy that stays alive but stops answering /healthz: a separate sentinel process terminates it so its s… |
| `OcxConfig.emptyCompletionRetry` | `src/types/config.ts:562` | Opt in to one identical-turn retry when a Responses completion has no text or tool call. |
| `OcxConfig.dropCodexSafetyBuffering` | `src/types/config.ts:564` | Suppress allowlisted client-facing Codex transport hints; provider enforcement is unchanged. |
| `OcxConfig.completeOnMaxOutputTokens` | `src/types/config.ts:566` | Opt in to completing truncated plain-text translated Responses turns; default off. |
| `OcxConfig.managementUsageMaxReadBytes` | `src/types/config.ts:586` | @deprecated Compatibility-only limit for bounded legacy usage readers. `GET /api/usage` always aggregates the complete ledger. |
| `OcxConfig.defaultModelAliases` | `src/types/config.ts:610` | Enable the shipped model alias patterns for providers without an override. |
| `OcxConfig.preferModelAliasIds` | `src/types/config.ts:625` | When `true`, the raw OpenAI-compatible `/v1/models` list publishes a safe alias (e.g. `SEK-glm-4.7-flash`) as the row `id` instead of `provi… |
| `OcxConfig.cursorEffortRows` | `src/types/config.ts:631` | Opt-in Cursor Private Inference compatibility rows. When true, `/v1/models` adds `<base-id>--<effort>` selectors for reasoning-capable model… |
| `OcxConfig.codexMainAccountHardLockThresholds` | `src/types/config.ts:661` | Per-window percentages: short defaults to 90, long to 98; integers 80..100, short <= long. |
| `OcxConfig.nativeMainRefresh` | `src/types/config.ts:675` | Who refreshes the native main ChatGPT login in CODEX_HOME (#2999). "codex" asks the Codex binary through app-server `getAuthStatus` and neve… |
| `OcxConfig.codexUseRemainingQuotaAccountIds` | `src/types/config.ts:677` | Use included quota to 100% for these accounts; preserves thresholds and credit-spending policy. |
| `OcxConfig.configRebaseProvenance` | `src/types/config.ts:679` | Explicit top-level deletion intent used by stale whole-config rebases. |
| `OcxConfig.openaiProviderTierVersion` | `src/types/config.ts:681` | OpenAI provider-contract migration marker (v2 = single `openai` provider with account mode). |
| `OcxConfig.googleAntigravityStaticCatalogVersion` | `src/types/config.ts:683` | One-time migration marker for Antigravity's static-catalog defaults. |
| `OcxConfig.apiSurfaces` | `src/types/config.ts:698` | Which public inference APIs this proxy serves. Read only through `resolveApiSurfaceSettings` in `src/protocols/settings.ts`, which fails clo… |
| `OcxConfig.opencodeClientExport` | `src/types/config.ts:712` | Opt-in opencode-side request timeouts emitted into the generated opencode provider block. Omitted by default (opencode keeps its native head… |
| `OcxConfig.omoClientExport` | `src/types/config.ts:714` | Opt-in dialect for the managed Pi-based omo block; omitted keeps `openai-completions` (#7431). |
| `OcxConfig.asideProfileSync` | `src/types/config.ts:716` | Aside account-backed profile synchronization; individual overrides survive bulk refresh. |
| `OcxConfig.subagentModels` | `src/types/config.ts:728` | Up to 5 Codex-facing catalog ids to feature first. Values may be bare catalog ids, exact account-qualified "<selector>/<native-openai-model>… |
| `OcxConfig.subagentModelsVersion` | `src/types/config.ts:730` | One-time featured-roster upgrade marker; later user ordering is preserved. |
| `OcxConfig.subagentModelFallback` | `src/types/config.ts:750` | Priority-ordered fallback models for spawned sub-agents. When the requested model is quota-exhausted or recently failed, opencodex rewrites… |
| `OcxConfig.subagentModelFallbackByModel` | `src/types/config.ts:761` | Per-primary-model fallback chains for spawned sub-agents, keyed by the requested primary model id (bare native or "provider/model"). Entries… |
| `OcxConfig.codexRoleTiers` | `src/types/config.ts:766` | Capability tier of named models for Codex role auto-assign, overriding its price-rank classification. Models no list names and no price cove… |
| `OcxConfig.codexRoleCapability` | `src/types/config.ts:771` | Measured-capability source for Codex role auto-assign. With an Artificial Analysis API key (a literal, ${ENV} or keychain reference) its ind… |
| `OcxConfig.subagentModelFallbackPollMs` | `src/types/config.ts:775` | TTL (ms) for cached sub-agent model availability probes. Default 60_000. |
| `OcxConfig.experimentalRealtimeWsBaseUrl` | `src/types/config.ts:798` | Explicit sideband websocket base for realtime/live joins, mirroring upstream's `experimental_realtime_ws_base_url`. The value is a ROOT (or… |
| `OcxConfig.grokExcludedModels` | `src/types/config.ts:808` | Model ids the user has EXCLUDED from the Grok Build managed block. Absent or empty means "everything visible", which is the historical behav… |
| `OcxConfig.streamMode` | `src/types/config.ts:829` | Windows/macOS SSE passthrough stream shape (#314 mitigation). On Windows, "auto" (default) selects eager relay only on a runtime proven to c… |
| `OcxConfig.injectionPrompt` | `src/types/config.ts:843` | Custom override for the injected v2 multi-agent guidance body (the text inside the <opencodex_subagent_guidance> tags). After guidance is en… |
| `OcxConfig.modelPinnedEfforts` | `src/types/config.ts:864` | Global model effort overrides, after provider model/wide pins; none means omission. |
| `OcxConfig.compactionRecovery` | `src/types/config.ts:874` | Opt-in failure-only recovery; never replaces the initial compaction model. |
| `OcxConfig.desktopCompatibility` | `src/types/config.ts:885` | Explicit opt-in; resumes Observe only using an existing trusted certificate and endpoints. |
| `OcxConfig.omitDisabledNativeModels` | `src/types/config.ts:915` | Omit explicitly disabled native catalog rows, retaining their validated inheritance template. Default: false; direct routing is unchanged. |
| `OcxConfig.customModelCatalogMigration` | `src/types/config.ts:923` | Internal, versioned evidence for reconciling custom-model deletions with pre-marker Codex catalog rows. Consumers must parse this defensivel… |
| `OcxConfig.blockedModelRedirects` | `src/types/config.ts:965` | Optional map of blocked model IDs to their replacement model IDs. When configured, incoming requests targeting a blocked model (including ac… |
| `OcxConfig.multiAgentSurfaceAdvisoryVersion` | `src/types/config.ts:972` | Which revision of the sub-agent surface advisory this install has answered. Absent means it has answered none. Written by the dashboard, nev… |
| `OcxConfig.plaintextV2AgentMessages` | `src/types/config.ts:980` | Experimental plaintext delivery for native v2 collaboration messages; disabled unless true. |
| `OcxConfig.agentTaskRecovery` | `src/types/config.ts:982` | Experimental, default-off ChatGPT recovery for encrypted V2 routed tasks. |
| `OcxConfig.quotaResetNotify` | `src/types/config.ts:1003` | Quota-reset detection and notification. Absent means off: no detection, no timer, no sink. Not in `getDefaultConfig()` on purpose — that fun… |
| `OcxConfig.catalogAutoRefresh` | `src/types/config.ts:1014` | Periodic provider model-catalog refresh (issue #3630). Absent means on at the hourly default; `enabled: false` or `intervalMinutes: 0` turns… |
| `OcxConfig.providerContextCapValues` | `src/types/config.ts:1018` | Last selected provider caps; retained while a cap is switched off. Not an active limit. |
| `OcxConfig.unauthenticatedLoopbackListener` | `src/types/config.ts:1055` | Optional second listener bound to 127.0.0.1 that admits data-plane requests without a credential (issue #1102). Why a separate listener rath… |
| `OcxConfig.noProxy` | `src/types/config.ts:1078` | Hosts that bypass `proxy` for OpenCodex's own outbound provider calls, merged into NO_PROXY at startup. Accepts a comma-separated string (NO… |
| `OcxConfig.stallTimeoutSec` | `src/types/config.ts:1083` | Upstream stall timeout (seconds). After this many seconds of no upstream data, emits response.incomplete. Default 300. Min 1. |
| `OcxConfig.connectTimeoutMs` | `src/types/config.ts:1092` | Connect timeout (ms) for upstream fetch — the deadline from dispatch until the upstream returns its first response header (covers DNS, TCP,… |
| `OcxConfig.shutdownTimeoutMs` | `src/types/config.ts:1095` | Opt-in (#7958): seconds (max 300) to wait for DNS after a pre-connect failure, then resend once. Unset or 0 is off.  offlineResendWaitSec?:… |
| `OcxConfig.codexNativeSteering` | `src/types/config.ts:1100` | Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in.  websockets?: boolean; Accept the Responses… |
| `OcxConfig.codexNativeInjection` | `src/types/config.ts:1102` | Experimental, default-off saved function-result injection on native multi-agent WebSockets. |
| `OcxConfig.storageCleanupPolicy` | `src/types/config.ts:1108` | Opt-in auto-cleanup policy for archived Codex sessions (issue #42 Phase 3). Default OFF (`enabled` false / unset). Never enabled implicitly.… |
| `OcxConfig.usageLedgerMaxBytes` | `src/types/config.ts:1115` | Opt-in ceiling in bytes for `usage.jsonl`. Absent means the ledger grows without limit, which stays the default: history an operator did not… |
| `OcxConfig.codexShimAutoRestore` | `src/types/config.ts:1121` | Restore an installed shim after a stable external Codex update replaces it. Default true. |
| `OcxConfig.codexProviderDisplayName` | `src/types/config.ts:1152` | Label Codex shows for the injected `opencodex` provider. Defaults to `OpenCodex Proxy`. Presentation only. Routing is keyed on the provider… |
| `OcxConfig.syncResumeHistory` | `src/types/config.ts:1159` | Compatibility mode: temporarily rewrite Codex resume-history metadata while the proxy is active so Codex App can show old OpenAI chats and o… |
| `OcxConfig.modelCacheTtlMs` | `src/types/config.ts:1161` | Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. |
| `OcxConfig.appOwnedMemoryBudgetMb` | `src/types/config.ts:1163` | Evictable retained app-state budget in MiB. Default 256; valid 64..4096. |
| `OcxConfig.cacheRetention` | `src/types/config.ts:1169` | Anthropic prompt-cache retention: "short" = 5-min ephemeral, "long" = 1-hour extended, "none" = disabled. Unset = "long" on first-party api.… |
| `OcxConfig.codexAccounts` | `src/types/config.ts:1189` | Codex multi-account pool. |
| `OcxConfig.pausedCodexAccountIds` | `src/types/config.ts:1191` | Account ids administratively excluded from future pool selection until resumed. |
| `OcxConfig.accountAutoPausePolicyRevisions` | `src/types/config.ts:1193` | Internal policy epochs; null marks malformed disk input and suppresses automatic pause. |
| `OcxConfig.codexAccountPauseState` | `src/types/config.ts:1194` |  |
| `OcxConfig.creditCodexAccountIds` | `src/types/config.ts:1200` | Account ids, `__main__` included, allowed to keep serving from ChatGPT credits once one of their usage windows is full. Every other account… |
| `OcxConfig.spendPoolAliases` | `src/types/config.ts:1220` | Historical salted pool aliases; h(pool,P) cannot map to Q != P for any configured provider P. |
| `OcxConfig.codexAccountPriorities` | `src/types/config.ts:1237` | Selection order per account id, higher used earlier; absent = 0. Keyed by id rather than stored on `codexAccounts` rows so the Desktop login… |
| `OcxConfig.codexAccountAutoSwitchThresholds` | `src/types/config.ts:1243` | Per-account proactive-switch threshold overrides. Missing account entry inherits `autoSwitchThreshold`; 0 disables usage-driven switching on… |
| `OcxConfig.activeCodexAccountPinned` | `src/types/config.ts:1249` | Account id the operator last selected by hand. Suppresses upward priority preemption until that account crosses the auto-switch threshold. S… |
| `OcxConfig.codexAccountNamespaces` | `src/types/config.ts:1255` | Public model-selector namespaces bound to one Codex account. Values are stored account ids; `"@main"` selects the Codex Desktop/main auth.js… |
| `OcxConfig.resetCreditAutoRedeem` | `src/types/config.ts:1268` | Opt-in auto-redemption of a main-account Codex reset credit shortly before it expires (#822). Default off. `leadTimeMinutes` (1–60, default… |
| `OcxConfig.codexAccountPriorityFailback` | `src/types/config.ts:1338` | Opt-in: return bound quota-strategy tasks to recovered higher-priority accounts. |
| `OcxConfig.codexPreserveSignedInAccount` | `src/types/config.ts:1340` | Prefer other identities, reserving the current native sign-in as pool fallback. |
| `OcxConfig.upstreamFailoverThreshold` | `src/types/config.ts:1346` | Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. |
| `OcxConfig.codexFailureWindow` | `src/types/config.ts:1351` | Sliding 60s transient-failure ratio for Codex pool placement. Default on. Set false to steer new threads from the consecutive counter only. |
| `OcxConfig.codexPinnedTransientPolicy` | `src/types/config.ts:1356` | What a manual pin does while its failure window is degraded. `hold` keeps using it and logs a warning. `detour-new-threads` places only new… |
| `OcxConfig.codexWsReuseAcrossTurns` | `src/types/config.ts:1358` | Opt-in: retain one Codex WebSocket per account and thread across turns. Default off. |
| `OcxConfig.upstreamHostCircuitThreshold` | `src/types/config.ts:1365` | Opt-in provider-origin circuit threshold for proven pre-connection reachability failures. Default 0 (disabled); range 0..20. The circuit nev… |
| `OcxConfig.maxUpstreamBodyBytes` | `src/types/config.ts:1376` | Opt-in ceiling, in bytes, for a serialized native Responses **passthrough** body. When the built body exceeds it OpenCodex refuses locally i… |
| `OcxConfig.upstreamRequestCompression` | `src/types/config.ts:1383` | Opt-in compression of native ChatGPT Responses HTTP request bodies (#7247): "gzip" or "zstd". Omitted, "off", or any other value = identity,… |
| `OcxConfig.maxInboundBodyBytes` | `src/types/config.ts:1399` | Opt-in ceiling, in bytes, on a decompressed INBOUND data-plane request body (#3573). Omitted or 0 = the built-in 256 MiB default. The lever… |
| `OcxConfig.maxConcurrentInboundBodyBytes` | `src/types/config.ts:1406` | Aggregate admission budget, in bytes, for concurrent raised-limit inbound HTTP bodies. Omitted or 0 = the built-in 512 MiB budget. `resolveC… |
| `OcxConfig.anthropicAccountPool` | `src/types/config.ts:1417` | Opt-in Anthropic OAuth PROACTIVE routing (#294). Default OFF. Sticky session affinity; new sessions may pick lowest known 5h usage. Experime… |
| `OcxConfig.oauthAccountFailover` | `src/types/config.ts:1431` | Generic OAuth multi-account PROACTIVE account preference (#2568, #695). Reactive 429 rotation — moving to another logged-in account of the S… |
| `OcxConfig.routingProfiles` | `src/types/config.ts:1442` | Routing policy profiles (Router Intelligence, RI-04+): explicitly requested `policy/<id>` (or configured alias) models select among an expli… |
| `OcxConfig.tokenGuardian` | `src/types/config.ts:1444` | Background proactive token refresh ("Token Guardian"). Off by default; see OcxTokenGuardianConfig. |
| `OcxConfig.corsAllowOrigins` | `src/types/config.ts:1446` | Additional exact origins allowed for CORS (e.g. HTTPS or chrome-extension://<id>). Loopback origins are always allowed. |
| `OcxConfig.subscriptionReserve`（仅上游） | `src/types/config.ts:687` | Opt-in weekly reserve for explicitly marked caller-forward Claude subscription turns. |
| `OcxConfig.routedCatalogDefaults`（仅上游） | `src/types/config.ts:883` |  |
| `OcxConfig.codexReserveEnabled`（仅上游） | `src/types/config.ts:1130` | Luna Reserve (#4961): seeded once from `codexDesktopAuthless`, then independent (absent = off). Grants no entitlement. |
| `OcxConfig.codexReserveMigration`（仅上游） | `src/types/config.ts:1132` | Internal marker recording that one-time seed. |
| `OcxConfig.codexWsIncrementalUpload`（仅上游） | `src/types/config.ts:1360` | Opt-in native WS upload deltas; implies cross-turn reuse. Default off. |
| `OcxConfig.upstreamHistorySlim`（仅上游） | `src/types/config.ts:1385` | Optional lossy shortening of historical native Codex images/tool text. |
| `OcxConfig.dashboardTrustedProxy`（仅上游） | `src/types/config.ts:1455` | #8338, opt-in, standalone only: the one reverse proxy a dashboard may sit behind and still remember devices. `origin` is the exact https ori… |
| `OcxProviderConfig.anthropicAccountPool` | `src/types/provider.ts:330` | Independent Anthropic pool settings; valid only on providers.anthropic2. |
| `OcxProviderConfig.tlsProfile` | `src/types/provider.ts:332` | Optional browser-compatible outbound TLS profile; disabled by default. |
| `OcxProviderConfig.modelAliases` | `src/types/provider.ts:336` | Native model id -> short, slash-free request alias. |
| `OcxProviderConfig.modelDisplayNames` | `src/types/provider.ts:344` | Display-only labels for exact native model ids discovered under this provider. |
| `OcxProviderConfig.defaultAliases` | `src/types/provider.ts:346` | Override the global built-in model-alias switch for this provider. |
| `OcxProviderConfig.codexToolMode` | `src/types/provider.ts:353` | Codex tool calling mode for routed models. "code_mode_only" (default) sets entry.tool_mode = "code_mode_only" (unified exec helper tool). "s… |
| `OcxProviderConfig.mcpMaxTools` | `src/types/provider.ts:372` | Cursor MCP compatibility bounds; positive integers when configured. |
| `OcxProviderConfig.mcpMaxSchemaBytes` | `src/types/provider.ts:373` |  |
| `OcxProviderConfig.mcpMaxResultBytes` | `src/types/provider.ts:374` |  |
| `OcxProviderConfig.modelAdapters` | `src/types/provider.ts:385` | Per-model wire override, keyed by the upstream native model id (after namespace and combo resolution). A single gateway can front models tha… |
| `OcxProviderConfig.fastWire` | `src/types/provider.ts:390` | Fast-wire declaration. `null` explicitly disables adapter-derived defaults; absence derives from the final model adapter. |
| `OcxProviderConfig.responseTierAuthoritative` | `src/types/provider.ts:397` | Whether echoed service_tier can confirm or deny Fast. Set false for a relay whose response metadata cannot establish the granted tier. Absen… |
| `OcxProviderConfig.chatCompletionsPath` | `src/types/provider.ts:415` | Optional relative send path for the `openai-chat` wire, mirroring `responsesPath`. Same shape rules: must start with `/`, no URL scheme, que… |
| `OcxProviderConfig.commandCodeVersion` | `src/types/provider.ts:421` | Command Code protocol version sent as `x-command-code-version` on /alpha/generate requests. The internal endpoint's schema drifts with the C… |
| `OcxProviderConfig.projectContext` | `src/types/provider.ts:423` | Include bounded repository context in Command Code envelopes. Default omitted/off sends empty memory/taste/skills. |
| `OcxProviderConfig.statelessResponses` | `src/types/provider.ts:430` | Responses upstream that stores nothing server-side (DeepSeek documents "the API is stateless"). Stateful request parameters are dropped, `st… |
| `OcxProviderConfig.requiresAdjacentResponsesToolResults` | `src/types/provider.ts:436` | Responses upstream whose parser requires an unambiguous call batch and its matched result batch to remain contiguous. Hook-injected context… |
| `OcxProviderConfig.requiresPairedResponsesToolResults` | `src/types/provider.ts:449` | Responses upstream whose parser also rejects a tool call that has no matching output anywhere in the replayed input, not merely one whose re… |
| `OcxProviderConfig.annotateEmptyToolOutputs` | `src/types/provider.ts:459` | When enabled, a tool result that is present but empty (no usable text or content part) is rewritten to an explicit annotation before it reac… |
| `OcxProviderConfig.supportsServiceTier` | `src/types/provider.ts:471` | Provider fallback for canonical Fast capability over an OpenAI `service_tier` wire. This pure tri-state feeds catalog publication, routing e… |
| `OcxProviderConfig.promoteAdditionalTools` | `src/types/provider.ts:488` | Whether to promote Codex Desktop's `additional_tools` input items into top-level `tools` and strip the wrapper from `input`. Enabled automat… |
| `OcxProviderConfig.preserveResponsesInputItemIds` | `src/types/provider.ts:504` | Whether to preserve Codex-private `input[].id` on `store: false` requests. Disabled by default: ordinary Responses upstreams interpret input… |
| `OcxProviderConfig.preserveResponsesMessageMetadata` | `src/types/provider.ts:512` | Whether to preserve ChatGPT-internal `internal_chat_message_metadata_passthrough` on outgoing input messages for noncanonical destinations.… |
| `OcxProviderConfig.projectResponsesLiteHostedSearchHistory` | `src/types/provider.ts:518` | Opt in to lossy hosted-search history notes on canonical Codex Lite ordinary turns and native v2 compaction triggers, even when search is de… |
| `OcxProviderConfig.modelReasoningEffortsAuthoritative` | `src/types/provider.ts:528` | Treat this provider's `modelReasoningEfforts` as authoritative at the wire, not only in the catalog. Adapters that ship their own per-model… |
| `OcxProviderConfig.dropResponsesReasoningItems` | `src/types/provider.ts:534` | Drop replayed Responses `reasoning` items from input history before forwarding. Some OpenAI-compatible Responses upstreams accept tool-call… |
| `OcxProviderConfig.decodesNativeCompactionBlobs` | `src/types/provider.ts:541` | Explicit opt-in for a relay that genuinely fronts OpenAI and can decode native compaction blobs. Absent or false degrades foreign blobs to a… |
| `OcxProviderConfig.supportsNativeCompactionTrigger` | `src/types/provider.ts:543` | Accept native Responses v2 `input` compaction_trigger items. Responses adapter only. |
| `OcxProviderConfig.supportsNativeCompactEndpoint` | `src/types/provider.ts:545` | Serve native Responses v1 /responses/compact. Responses adapter only; no auth authority. |
| `OcxProviderConfig.allowEncryptedV2AgentTasks` | `src/types/provider.ts:551` | Trust this direct key-auth Responses provider to consume or relay opaque encrypted V2 agent tasks. OpenCodex does not decrypt, translate, or… |
| `OcxProviderConfig.noProxy` | `src/types/provider.ts:585` | Destinations this provider reaches without a proxy, in `NO_PROXY` syntax. Applied to whichever route `proxy` resolved to, so it carves an ex… |
| `OcxProviderConfig.upstreamWebsocket` | `src/types/provider.ts:608` | Opt-in upstream Responses WebSocket transport for `openai-responses` requests. When true, streaming POST turns use the configured Responses… |
| `OcxProviderConfig.directGeminiWireRenames` | `src/types/provider.ts:615` | Google only. When `false`, the AI Studio (direct) path sends Gemini Flash ids unchanged to the wire instead of applying the `-tiered` suffix… |
| `OcxProviderConfig.apiKeyPool` | `src/types/provider.ts:639` | Multi-key pool (API-key twin of OAuth multiauth). `apiKey` always mirrors the ACTIVE entry so routing stays single-key; managed via /api/pro… |
| `OcxProviderConfig.accountAutoPause` | `src/types/provider.ts:644` | Permanent account refusal policy. Explicit opt-in; with no key at all, a Cloud Code Assist provider still pauses on the first Terms of Servi… |
| `OcxProviderConfig.apiKeyPoolStrategy` | `src/types/provider.ts:654` | Optional proactive ordering for `apiKeyPool` when the committed key is already cooling. Deliberately NOT named like the OAuth `accountPoolSt… |
| `OcxProviderConfig.apiKeySelectionRevision` | `src/types/provider.ts:656` | Changes on manual selection (including re-selection) and committed automatic allocation. |
| `OcxProviderConfig._apiKeyAttempt` | `src/types/provider.ts:658` | Runtime only. Never expose in management responses or persist a routed provider. |
| `OcxProviderConfig.retainModels` | `src/types/provider.ts:699` | Per-provider retention allowlist for authoritative live discovery. When non-empty, any model id in this list is preserved in the routed cata… |
| `OcxProviderConfig.newModelPolicy` | `src/types/provider.ts:704` | Override for newly discovered models. Absent/"inherit" uses the install policy. `admit` appends arrivals to a custom `selectedModels` (never… |
| `OcxProviderConfig.modelPreset` | `src/types/provider.ts:718` | Model-preset marker for `selectedModels` (#2465). Absent means "all", exactly today's semantics — an existing provider is never narrowed by… |
| `OcxProviderConfig.inferContextWindow` | `src/types/provider.ts:738` | Custom providers only, default off: fill a missing context window from bundled model-ID metadata before the Context cap / 128k fallback. An… |
| `OcxProviderConfig.modelContextTiers` | `src/types/provider.ts:740` | Per-model Copilot upstream tier; only the github-copilot route sends it. |
| `OcxProviderConfig.modelInputModalities` | `src/types/provider.ts:742` | Model-specific Codex catalog input modalities, e.g. ["text"] or ["text", "image"]. |
| `OcxProviderConfig.modelCapabilities` | `src/types/provider.ts:749` |  |
| `OcxProviderConfig.modelMaxInputTokens` | `src/types/provider.ts:751` | Model-specific max input token limits. Values cap auto_compact_token_limit. |
| `OcxProviderConfig.modelAutoCompactTokenLimits` | `src/types/provider.ts:756` | Per-model soft compaction budgets. Values may only lower the effective context/max-input envelope; they never raise hard admission limits. |
| `OcxProviderConfig.defaultMaxOutputTokens` | `src/types/provider.ts:761` | Provider-wide fallback for chat-completions `max_tokens` when the caller omits Responses `max_output_tokens`. Adapters still let an explicit… |
| `OcxProviderConfig.minMaxOutputTokens` | `src/types/provider.ts:763` | Opt-in Azure Responses floor for explicit positive output budgets; may raise the caller cap. |
| `OcxProviderConfig.modelMaxOutputTokens` | `src/types/provider.ts:765` | Model-specific fallback output token budgets. Exact/model-pattern entries beat the provider default. |
| `OcxProviderConfig.autoReviewModelOverrides` | `src/types/provider.ts:801` | Per-model auto-review (approval) overrides for routed models of this provider. Keys are exact upstream model ids under this provider (either… |
| `OcxProviderConfig.forwardClientHeaders` | `src/types/provider.ts:804` | Inbound client metadata headers to copy to this provider when the outbound field is otherwise unset. |
| `OcxProviderConfig.openRouterRouting` | `src/types/provider.ts:806` | Default provider-routing preferences for models sent through the canonical OpenRouter API. |
| `OcxProviderConfig.modelOpenRouterRouting` | `src/types/provider.ts:808` | Exact model-id overrides for `openRouterRouting`. Each matching entry replaces the default. |
| `OcxProviderConfig.vercelGatewayRouting` | `src/types/provider.ts:810` | Default provider-routing preferences for models sent through Vercel AI Gateway (issue #1406). |
| `OcxProviderConfig.modelVercelGatewayRouting` | `src/types/provider.ts:812` | Exact model-id overrides for `vercelGatewayRouting`. Each matching entry replaces the default. |
| `OcxProviderConfig.oauthAccountFailover` | `src/types/provider.ts:831` | Per-provider override for the generic OAuth PROACTIVE account preference (#2568, #695). Reactive 429 rotation is presence-driven and cannot… |
| `OcxProviderConfig.modelSuffixBracketStrip` | `src/types/provider.ts:865` | Strip one trailing bracketed suffix from model ids before sending them upstream. |
| `OcxProviderConfig.refreshPolicy` | `src/types/provider.ts:871` | Override the guardian's proactive-refresh policy for this provider. When unset, the provider's built-in risk-tiered default applies (see OAU… |
| `OcxProviderConfig.modelReasoningEfforts` | `src/types/provider.ts:879` | Model-specific Codex-visible reasoning tiers. An empty array means “do not expose effort”. |
| `OcxProviderConfig.modelSuppressSyntheticMax` | `src/types/provider.ts:881` | Catalog-only: do not synthesize a missing max rung for matching routed models. |
| `OcxProviderConfig.modelDefaultReasoningEfforts` | `src/types/provider.ts:883` | Model-specific default Codex reasoning tier; must also be present in the visible tier list. |
| `OcxProviderConfig.pinnedReasoningEffort` | `src/types/provider.ts:885` | Operator-owned effort override; none omits effort and uses the provider default. |
| `OcxProviderConfig.modelPinnedReasoningEfforts` | `src/types/provider.ts:887` | Per-model operator override, ahead of provider-wide and global pins; caps still apply. |
| `OcxProviderConfig.modelSupportsReasoningSummaries` | `src/types/provider.ts:892` | Model-specific Codex reasoning-summary capability. Set false when an OpenAI-compatible Responses backend rejects Codex summary-delivery fiel… |
| `OcxProviderConfig.modelSupportsVerbosity` | `src/types/provider.ts:898` | Model-specific Codex Responses verbosity capability. Set false when the upstream ignores `text.verbosity`; the catalog hides the no-op picke… |
| `OcxProviderConfig.supportsVerbosity` | `src/types/provider.ts:904` | Provider-wide Codex Responses verbosity capability, applied to models the per-model map does not enumerate (a live-discovered id, for exampl… |
| `OcxProviderConfig.modelReasoningSummaryDelivery` | `src/types/provider.ts:909` | Per-model wire value for Responses `stream_options.reasoning_summary_delivery`. Presence also advertises reasoning-summary support for that… |
| `OcxProviderConfig.modelPreferHostedTools` | `src/types/provider.ts:922` | Exact-model hosted tools that win collisions with Codex client tool declarations. Use for non-forward Responses gateways that reserve a host… |
| `OcxProviderConfig.supportsOpenAiWebSearchToolFields` | `src/types/provider.ts:928` | Whether the Responses upstream accepts OpenAI's extended hosted web_search fields. Set false only for a provider whose native contract rejec… |
| `OcxProviderConfig.xaiResponsesXSearch` | `src/types/provider.ts:934` | Opt xAI Responses destinations into the provider-hosted `x_search` declaration when a live `web_search` tool survives final request normaliz… |
| `OcxProviderConfig.xaiResponsesDefaultVersion` | `src/types/provider.ts:936` | One-time Grok subscription wire upgrade; later explicit Chat choices remain authoritative. |
| `OcxProviderConfig.zaiResponsesDefaultVersion` | `src/types/provider.ts:942` | One-time Z.AI coding-plan wire upgrade. The router already canonicalizes the `zai` row onto the Responses destination at request time; the m… |
| `OcxProviderConfig.supportsResponsesCustomTools` | `src/types/provider.ts:948` | Whether the Responses upstream accepts native custom tools and custom_tool_call items. Set false only for a provider whose native contract r… |
| `OcxProviderConfig.unsupportedHostedTools` | `src/types/provider.ts:965` | Hosted tool declarations this Responses destination rejects, so they are stripped from the request instead of being forwarded and 400'd. Thi… |
| `OcxProviderConfig.responsesSnapshotRepair` | `src/types/provider.ts:984` | Provider-local repair for Responses gateways whose lifecycle snapshots omit canonical fields or closing events (#893). Disabled by default a… |
| `OcxProviderConfig.messagePhaseInference` | `src/types/provider.ts:992` | Infer the commentary/final_answer phase on assistant messages for Responses passthrough providers whose upstream omits it (e.g. third-party… |
| `OcxProviderConfig.webSearchBridge` | `src/types/provider.ts:1002` | Opt-in hosted-web-search bridge for this KEY-auth Responses passthrough provider (#3761). Absent or disabled leaves the passthrough byte-ide… |
| `OcxProviderConfig.reasoningEffortMap` | `src/types/provider.ts:1011` | Provider-wide mapping from Codex effort labels to upstream `reasoning_effort` values. Map a label to the reserved value `"__omit__"` to send… |
| `OcxProviderConfig.modelReasoningEffortMap` | `src/types/provider.ts:1018` | Model-specific mapping from Codex effort labels to upstream `reasoning_effort` values. Map a label to the reserved value `"__omit__"` to sen… |
| `OcxProviderConfig.noReasoningModels` | `src/types/provider.ts:1025` | Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops reasoning_effort for these even when Codex selec… |
| `OcxProviderConfig.noTemperatureModels` | `src/types/provider.ts:1027` | Model ids that reject caller-specified temperature. |
| `OcxProviderConfig.noTopPModels` | `src/types/provider.ts:1029` | Model ids that reject caller-specified top_p. |
| `OcxProviderConfig.noStopModels` | `src/types/provider.ts:1036` | Model ids that reject caller-specified stop sequences. The openai-chat adapter drops `stop` for these (xAI grok-4.6 answers 400 invalid-argu… |
| `OcxProviderConfig.noPenaltyModels` | `src/types/provider.ts:1038` | Model ids that reject caller-specified presence/frequency penalty values. |
| `OcxProviderConfig.noStructuredOutputModels` | `src/types/provider.ts:1044` | Model ids whose Chat Completions endpoint rejects `response_format`. Structured-output translation remains enabled by default; this is a nar… |
| `OcxProviderConfig.noJsonSchemaModels` | `src/types/provider.ts:1057` | Model ids whose Chat Completions endpoint rejects `response_format` of type `json_schema` specifically. Such a request is downgraded to `{ t… |
| `OcxProviderConfig.omitReasoningEffortWithToolsModels` | `src/types/provider.ts:1065` | Model ids that accept a reasoning-effort field on an ordinary turn but reject it once function tools are present. The model keeps its advert… |
| `OcxProviderConfig.parallelToolCalls` | `src/types/provider.ts:1073` | Allow multiple tool calls per completion. DEFAULT-ON for openai-chat providers (the buffered stream parser assembles interleaved/fragmented… |
| `OcxProviderConfig.pinParallelToolCallsFalse` | `src/types/provider.ts:1083` | Opt-in: when `parallelToolCalls` is `false`, actually send `parallel_tool_calls: false` on the `/chat/completions` wire for this provider. B… |
| `OcxProviderConfig.terminalContinuationGuard` | `src/types/provider.ts:1095` | Opt-in: extend the no-tool-call terminal continuation guard to this provider's `openai-chat` routed turns. The guard (originally Anthropic-o… |
| `OcxProviderConfig.openaiChatEofTolerance` | `src/types/provider.ts:1102` | Opt-in for OpenAI-compatible chat gateways that may close after emitting a complete tool-call delta without `finish_reason` or `[DONE]`. The… |
| `OcxProviderConfig.foldDeveloperRoleToSystem` | `src/types/provider.ts:1115` | Opt-in: fold a `developer` message into a `system` message instead of forwarding the role. `developer` is part of the Chat Completions messa… |
| `OcxProviderConfig.singleLeadingSystemMessage` | `src/types/provider.ts:1117` | Merge text-only Chat instruction messages into one leading system message. LM Studio seeds true. |
| `OcxProviderConfig.promptCacheKey` | `src/types/provider.ts:1123` | Opt-in: forward `prompt_cache_key` to the upstream `/chat/completions` body. OpenAI-specific extension; strict backends (Groq, Cerebras, etc… |
| `OcxProviderConfig.chatServiceTier` | `src/types/provider.ts:1144` | Opt-in: forward caller `service_tier` values to the upstream `/chat/completions` body. On a classified route it governs foreign values (for… |
| `OcxProviderConfig.responsesItemIdRepair` | `src/types/provider.ts:1150` | Provider-local passthrough SSE repair for broken openai-responses gateways that reuse exact placeholder message/reasoning ids or omit the te… |
| `OcxProviderConfig.autoToolChoiceOnlyModels` | `src/types/provider.ts:1152` | Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. |
| `OcxProviderConfig.preserveReasoningContentModels` | `src/types/provider.ts:1154` | Model ids that expect prior assistant `reasoning_content` to be preserved in chat history. |
| `OcxProviderConfig.requiresReasoningPlaceholderModels` | `src/types/provider.ts:1162` | Model ids whose upstream hard-rejects a tool_call continuation missing `reasoning_content` (DeepSeek thinking mode: HTTP 400). When the repl… |
| `OcxProviderConfig.showThinkingSummary` | `src/types/provider.ts:1168` | Default to displaying provider-authored summaries when Responses summary is omitted. Explicit wire summary:"none" wins; false disables a see… |
| `OcxProviderConfig.hideRawReasoning` | `src/types/provider.ts:1176` | Keep raw content-channel reasoning out of client frames for this provider. Provider-authored summaries (thinking_delta) stay visible, so an… |
| `OcxProviderConfig.retryOn429` | `src/types/provider.ts:1189` | Opt-in same-target 429 retry policy. Codex itself never retries 429 (it retries 5xx only, openai/codex#30471), and single-key pools have no… |
| `OcxProviderConfig.retryOnReset` | `src/types/provider.ts:1201` | Opt-in replacement of self-contained Responses sends (`providers.<name>.retryOnReset`). Disabled unless present; `{}` opts in. Native sends… |
| `OcxProviderConfig.reasoningSplitModels` | `src/types/provider.ts:1206` | Model ids whose OpenAI-compatible chat endpoint accepts `reasoning_split: true` and returns thinking separately in `reasoning_content` / `re… |
| `OcxProviderConfig.inlineThinkTagModels` | `src/types/provider.ts:1216` | Model ids served by a gateway that runs no server-side reasoning parser, so a thinking model leaves its chain of thought inline in `content`… |
| `OcxProviderConfig.reasoningDetailsModels` | `src/types/provider.ts:1224` | Model ids whose chat endpoint carries thinking as a structured `reasoning_details` array (MiniMax M-series with `reasoning_split`): stream d… |
| `OcxProviderConfig.thinkingToggleModels` | `src/types/provider.ts:1230` | Model ids whose reasoning is a vendor `thinking: {type}` toggle on the chat-completions wire (MiMo v2.x, GLM 5/5.1 style), NOT an OpenAI `re… |
| `OcxProviderConfig.thinkingBudgetModels` | `src/types/provider.ts:1236` | Model ids whose reasoning is a `thinking_budget` integer on the chat-completions wire (Qwen3.x style), NOT an OpenAI `reasoning_effort` ladd… |
| `OcxProviderConfig.escapeBuiltinToolNames` | `src/types/provider.ts:1238` | Anthropic-compatible gateways that need custom tool names escaped on the wire. |
| `OcxProviderConfig.anthropicEofTolerance` | `src/types/provider.ts:1245` | Anthropic-compatible gateways (e.g. AgentRouter) that may close the stream before `message_stop`. With this enabled the adapter completes an… |
| `OcxProviderConfig.googleToolSchemaPolicy` | `src/types/provider.ts:1275` | Google tool-schema compatibility policy. Omitted preserves compatible report-only behavior. |
| `OcxProviderConfig.mcpServers` | `src/types/provider.ts:1285` | Cursor adapter only: MCP servers opencodex starts/connects and exposes to the Cursor agent as callable tools. Each entry is spawned (stdio `… |
| `OcxProviderConfig.desktopExecutor` | `src/types/provider.ts:1291` | Cursor adapter only: opt-in external executor for computer-use / record-screen. opencodex is headless and cannot control a screen itself; pr… |
| `OcxProviderConfig.unsafeAllowNativeLocalExec` | `src/types/provider.ts:1299` | Cursor adapter only: unsafe opt-in escape hatch for Cursor server-driven built-in local read/write/delete/ls/grep/shell/fetch execution. Pre… |
| `OcxProviderConfig.nativeLocalExec` | `src/types/provider.ts:1312` | Cursor adapter only: native local exec policy mode (exec-policy.ts). "off" (default) rejects server-driven local exec; "on" always allows it… |
| `OcxProviderConfig.aliasTemplate`（仅上游） | `src/types/provider.ts:342` | Opt-in alias template for models without a manual or built-in alias (#7705), for example `{providerAlias}-{modelBasename}`. Derived at resol… |
| `OcxProviderConfig.connectTimeoutMs`（仅上游） | `src/types/provider.ts:363` | Per-provider override of the global `connectTimeoutMs` (response-header arrival deadline) for routed HTTP adapter sends, including routed mo… |
| `OcxProviderConfig.stallTimeoutSec`（仅上游） | `src/types/provider.ts:370` | Per-provider override of the global `stallTimeoutSec` for routed HTTP responses, streaming runTurn delivery, and inactivity in the image/vid… |
| `OcxProviderConfig.arkKimiResponsesModels`（仅上游） | `src/types/provider.ts:536` | Exact Ark Kimi endpoint IDs requiring the narrow stateless Responses replay projection. |
| `OcxProviderConfig.anthropicOAuthUserInstructions`（仅上游） | `src/types/provider.ts:633` | Opt-in translated OAuth compatibility: move caller system instructions to user content, losing system-role precedence. Default false; API-ke… |
| `OcxProviderConfig.thinkingDisplay`（仅上游） | `src/types/provider.ts:915` | Anthropic adaptive `thinking.display` policy for this provider (#8363). `auto` and omission keep the built-in selection: native Opus 5.5 pro… |
| `OcxProviderConfig.modelThinkingDisplay`（仅上游） | `src/types/provider.ts:917` | Per-model override of `thinkingDisplay`, keyed by the exact upstream model id. |
| `OcxProviderConfig.unsupportedHostedToolsWithClientTools`（仅上游） | `src/types/provider.ts:978` | Hosted tool declarations this Responses destination rejects only in combination with client tools, so they are stripped when the same reques… |
| `OcxProviderConfig.estimateMissingUsage`（仅上游） | `src/types/provider.ts:997` | Opt-in (#7427): on a native Responses route, add estimated `usage` to a completed response the provider sent without one, marked by `x-openc… |
| `OcxProviderConfig.cacheAffinity`（仅上游） | `src/types/provider.ts:1131` | Conversation affinity to the key-pool credential that served a conversation's last turn, so its upstream prompt cache is read again on the n… |
| `OcxProviderConfig.rawReasoningAsSummary`（仅上游） | `src/types/provider.ts:1182` | Default-off Chat-to-Responses display compatibility: expose raw reasoning on the summary channel, verbatim (not a generated summary). hideRa… |
| `OcxProviderConfig.anthropicImageContextRecovery`（仅上游） | `src/types/provider.ts:1247` | Opt in to one owner-bound image-context recovery after an upstream 413. |
| `OcxProviderConfig.forwardAdvisorTool`（仅上游） | `src/types/provider.ts:1254` | Claude Code's typed Advisor server tool (`advisor_20260301`) on the translated Messages lane. Absent: forwarded only to an `anthropic`-adapt… |
| `OcxProviderConfig.perMessageEffort`（仅上游） | `src/types/provider.ts:1262` | Experimental, default off (#6895). On an `anthropic`-adapter provider that sends to `api.anthropic.com` with an API key, a Codex conversatio… |

</details>
