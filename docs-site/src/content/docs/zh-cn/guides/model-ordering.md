---
title: 模型排序
description: opencodex 如何确定 Codex 模型选择器和 spawn_agent 模型 override 的顺序。
---

Codex 模型选择器不会保留 opencodex 配置中 provider 的声明顺序或模型数组顺序。最终顺序由目录
priority 决定；priority 相同的路由模型则使用确定性的字母顺序。

## Codex 应用的规则

Codex 的 models-manager 按 `priority` 升序排列选择器中可见的目录条目。目录数组本身的顺序会被
丢弃，因此在生成的 JSON 数组中把某个条目前移，并不会让它在选择器中前移。该约束直接记录在
`src/codex/catalog/sync.ts` 中。

因此，自 PX-1276 起，`subagentModels` 不再覆盖全局目录 `priority`（`0` 至 `4`），也不会再把精选模型强制置顶到全局模型选择器。取而代之的是，代理会在出站转发时根据 `effectiveSubagentRoster().advertised` 在 V1 与 V2 两种协作面上重写 `spawn_agent` 工具描述中的候选列表，而全局选择器继续沿用自然优先级或 `modelPickerOrder`。

没有开启完整选择器排序时，相关的无 selector priority 如下：

| 目录条目 | Priority | 来源 |
| --- | ---: | --- |
| 普通路由模型 | `5` | `src/codex/catalog/sync.ts` 中创建路由条目的逻辑 |
| `modelPickerOrder` 列出的路由模型（仅路由排序模式） | `1000 + i` | `src/codex/catalog/sync.ts` 中仅控制显示的排序区间 |
| 原生 GPT slug | `sourcePriority`（回退 `9`） | 共享原生来源优先级解析器 |

原生来源优先级依次读取当前发现结果、原始目录备份、同模型的保留来源值与上游快照，每项须为 `0` 至 `1000` 的整数，非法值跳过，最终回退为 `9`。已发布的显示 priority 不会反向用作来源优先级。实时 Codex 模型列表、落盘目录与模型缓存对相同输入保持一致的 priority。账户 selector 分组保留其 stride 策略；完整选择器排序仍是最终覆盖项。

管理 API 在 `src/server/management/agent-settings-routes.ts` 中使用 `slice(0, 5)`，把
`subagentModels` 限制为最多五项。这与 Codex `spawn_agent` 界面最多公布五个模型 override 的行为
一致。五项之外的模型仍可继续显示在主选择器中，也可通过精确 id 调用。

## Priority 相同时如何排序

所有普通路由模型的 priority 都是 `5`，因此需要处理并列顺序。在创建目录条目之前，
`gatherRoutedModels()` 会先按 provider 名称、再按模型 id 对路由模型列表进行字母排序
（`src/codex/catalog/provider-fetch.ts`）。

因此，以下配置顺序不会影响最终顺序：

- `providers` 对象中各 key 的声明顺序；
- 每个 provider 的 `models` 数组中各 id 的排列顺序。

## 可见性与排序彼此独立

`selectedModels` 和 `disabledModels` 只决定暴露哪些路由模型，不控制排序。
`filterCatalogVisibleModels()` 会把两类选择转换为 `Set` 查询，并在不把数组当作 rank 的情况下过滤
已收集的列表（`src/codex/catalog/provider-fetch.ts`）。

因此，调整 `selectedModels` 或 `disabledModels` 的数组顺序不会改变模型在选择器中的位置，只会
影响模型是否包含在内。

## 最终选择器顺序

未配置 `modelPickerOrder` 时：

1. 所有路由模型的 priority 均为 `5`，先按 provider、再按模型 id 字母排序；
2. 原生 GPT 条目沿用正常的来源 priority（回退 `9`）。

配置 `subagentModels` 不再把精选模型顶到其他路由或原生模型前面；它只在 `multiAgentGuidanceEnabled` 开启且目录状态不为 `stale` / `unknown` 时，通过出站重写控制 `spawn_agent` 推荐的模型列表。

## 示例

假设 `subagentModels` 按以下顺序包含五个 id：

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

未设置 `modelPickerOrder` 时，全局选择器优先级保持自然分布：

| 选择器分组 | 模型 | Priority | 出现在此处的原因 |
| --- | --- | ---: | --- |
| 路由模型 | `anthropic/claude-opus-4-6`, `opencode-go/glm-5.2`, ... | `5` | 先按 provider 字母排序，再按模型 id 字母排序 |
| 原生模型 | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, ... | `sourcePriority`（回退 `9`） | 原生来源顺序 |

与此同时，`spawn_agent` 工具描述通过出站改写按配置顺序展示这五个 `subagentModels` 推荐项。存在账户 selector 时，裸原生选择会展开为 selector-qualified 分组，并仍受五个展示上限约束。

## 更改顺序

使用 `subagentModels` 选择并排列提供给 `spawn_agent` 的推荐模型。仪表盘的 **Sub-agents** 页面可以调整
裸原生和路由 id 的顺序。配置和 `ocx agent subagents set` 也接受精确的账户限定
`<selector>/<native-openai-model>` id，仪表盘会保留已保存的 id，即使当前不可用。配置的
id 请勿超过五个。存在账户 selector 时，一个裸原生选项可能展开为多个 selector-qualified 行，因此
已配置的选项与公布的行不一定一一对应。

`modelPickerOrder` 只控制选择器的显示顺序。如果列表只有路由 ID `<provider>/<model>`，
列出的路由行会按列表顺序进入独立的显示区间（`1000 + i`）。未列出的路由行保留原有优先级（`5`），
因此仍排在该区间之前，原生行也保持原有位置。
需要控制相对顺序的路由行都应列入列表。

要对整个选择器排序，请加入至少一个不含 `/` 的裸目录 ID，例如 `gpt-5.6-sol`。
空字符串或只有空白的条目不会启用此模式。

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

列出的行按数组顺序排在最前面，未列出的行随后按原有优先级排列。匹配使用精确的目录 ID：
`gpt-5.6-sol` 和 `openai/gpt-5.6-sol` 是不同的行。同一路由 ID 的原始写法和编码写法也可匹配，
但精确匹配优先于等价匹配。空条目和只有空白的条目会被忽略。账户限定行必须使用包含 selector 的完整 ID。

### 迁移提醒：现有列表中的原生 ID

以前 `modelPickerOrder` 中的裸原生 ID 会被忽略。现在，现有列表只要包含这样的 ID，就会启用
整个选择器的排序，包括置顶行。要保持以前只调整路由行的行为，请移除裸 ID。
未设置、空列表、只有空白条目的列表以及只有路由 ID 的列表都保留原有行为。

`modelPickerOrder` 保留 OpenCodex 按原有优先级计算最多五个首选候选项的规则，供子代理指导使用。
每个移动行的原有优先级与原生 `priority` 分开保存；仅改变选择器顺序不得改变这一计算结果。
它也不会限制通过精确模型名称指定 override 的资格：公布的列表不是允许列表，现有的认证、模型、
effort 和后端限制仍然适用。

原生 Codex 按原生 `priority` 排序，从符合条件且在选择器中可见的模型中取前五个，公布在
`spawn_agent` 中。这适用于 V1，以及公开模型 override 的 V2。因此，即使 OpenCodex 的首选候选项
不变，原生公布的五个模型仍可能随选择器顺序改变。V1 不接收 OpenCodex 注入的首选模型列表。
V2 在客户端目录状态允许时，可以额外接收基于原有优先级的 OpenCodex 指导；这些指导不会重排
原生工具公布的列表。

`disabledModels` 和各提供商的 `selectedModels` 仍是可见性字段。没有独立的 `modelOrder`、
`providerOrder` 或优先级映射设置。

## 仪表盘排序预设与自定义混排

在 **Models** 中选择默认、按模型名 A–Z、按提供商或使用量快照，再应用顺序；或选择 **自定义顺序**，在同一列表里拖拽混排可见原生模型与路由模型后保存草稿。预设与自定义均基于当前可见的原生和路由 ID 保存 `modelPickerOrder`（预设同步记录 `modelPickerOrderMode`：`alphabetical`、`provider` 或 `most-used`）。使用量排序仅在应用时读取一次保留的全部历史；重新打开或模型增减不会重新计算。即使没有可用模型，默认也能清除两个字段。

`GET/PUT /api/subagent-models` 的 `chosen`、`available` 保留禁用或缺失的已存 roster；`pickerAvailable` 返回当前可见的裸原生 ID 与路由 ID 统一候选集（与 PUT 校验一致）。Models 只发送 `pickerOrder`、`pickerOrderMode`，不发送 `models`。只保存 roster 不影响排序，非法输入或保存失败会保留原状态。裸原生 ID 在编辑器与 `ocx models order` 中按原样精确匹配，不做别名猜测，含原生 ID 的已保存顺序可直接再次编辑与往返保存。

含裸原生 ID 的顺序会在 Codex 目录启用完整混排；Claude 发现列表仍只重排路由分组，Claude 原生前缀、明确的 Desktop 配置及 alias 归属不变。OpenCodex 指导排序、`spawn_agent` 覆盖与 fallback 设置保持独立不受影响。保存不会重启客户端；目录刷新可能尚未完成，旧列表可能需要重新打开客户端。
