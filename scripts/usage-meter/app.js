"use strict";
const $ = id => document.getElementById(id);
let scope = "session";
let state = null;
let busy = false;
const params = new URLSearchParams(location.search);
const conversation = params.get("conversation");
const number = value => value == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const tokens = value => value == null ? "—" : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : number(value);
const usd = value => value == null ? "—" : `$${value < .01 ? value.toFixed(4) : value.toFixed(2)}`;
const percentage = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const rate = metric => metric?.kind === "value" ? metric.value.toFixed(1) : "—";
const clock = value => value == null ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
const text = (id, value) => { $(id).textContent = value; };
function node(tag, value, className) {
  const el = document.createElement(tag);
  if (value != null) el.textContent = value;
  if (className) el.className = className;
  return el;
}
function render() {
  if (!state) return;
  const isSession = scope === "session";
  const summary = state.ready ? (isSession ? state.session : state.today) : null;
  const latest = state.ready ? (isSession ? state.latest : state.latestGlobal) : null;
  text("summary-heading", isSession ? "本会话累计" : "今日累计 · 美东时间");
  text("routes-heading", isSession ? "本会话线路" : "今日线路");
  $("session-tab").setAttribute("aria-pressed", String(isSession));
  $("today-tab").setAttribute("aria-pressed", String(!isSession));
  const incomplete = Boolean(state.invalidRows || state.oversizedRows);
  text("connection", !state.ready ? "首次同步中，正在分块读取本地账本…" : state.error ? "账本读取失败，保留上次数据；请检查 OpenCodex 账本是否可读。" : !state.sourceExists ? "未找到 OpenCodex 账本；请确认此机器已产生请求。" : incomplete ? "账本有无法读取的记录，统计可能不完整。" : state.pricing !== "loaded" ? "线路定价配置不可用；当前金额仅采用可匹配的 API 标价。" : isSession && !summary?.requests ? "本会话尚无匹配记录；可切换查看今日全部线路。" : `已连接本机 OpenCodex${isSession ? ` · 会话 ${state.conversation?.slice(0, 8) ?? "未选择"}` : " · 所有会话"}`);
  $("connection").classList.toggle("warning", Boolean(state.error) || incomplete || state.pricing !== "loaded");
  text("route", latest ? `${latest.provider} / ${latest.servedModel}` : "此范围暂无请求记录");
  text("request-time", latest ? clock(latest.timestamp) : "");
  text("speed", rate(latest?.generation));
  text("ttft", latest?.firstOutputMs != null ? `${(latest.firstOutputMs / 1000).toFixed(1)} s` : "—");
  text("e2e", latest ? `${rate(latest.endToEnd)} tok/s` : "—");
  text("cache", percentage(latest?.cacheRate));
  text("last-usage", latest ? `输入 ${tokens(latest.inputTokens)} · 输出 ${tokens(latest.outputTokens)} · 本轮估算 ${usd(latest.cost.usd)}` : "有请求记录后显示输入、输出和本轮费用。");
  const notes = [];
  if (latest && !latest.completed) notes.push(`请求${{ failed: "失败", incomplete: "未完成", aborted: "已取消" }[latest.outcome] ?? "未完成"}，不计成功速度`);
  if (latest?.generation?.timingBasis === "legacy-post-visible-output") notes.push("旧记录速度不含首字前的思考时间，可能偏高");
  if (latest?.cacheProvenance && latest.cacheProvenance !== "observed") notes.push("本轮缓存未被上游实际报告");
  if (latest?.cost.usd == null && latest) notes.push("本轮价格或用量不完整，费用未知");
  if (latest?.cost.lowerBound) notes.push("本轮金额仅为已知下界");
  text("last-note", notes.join("；"));
  text("tokens", tokens(summary?.totalTokens));
  $("tokens").title = summary ? `${number(summary.totalTokens)} Token（输入与输出合计）` : "";
  text("cost", summary ? `${summary.unpricedRequests || summary.unmeteredRequests ? "已知部分 " : "≈ "}${usd(summary.estimatedCostUsd)}` : "—");
  text("request-count", summary ? `${number(summary.requests)} 次请求` : "");
  text("coverage", summary ? `已计价 ${number(summary.pricedRequests)} 次 · 未计价 ${number(summary.unpricedRequests)} 次 · 无可用计量 ${number(summary.unmeteredRequests)} 次` : "");
  text("scope-note", isSession ? "累计包含多次发送的上下文，不是当前上下文占用。" : "只含经过本机 OpenCodex 的流量；其他机器与直连流量未纳入。");
  const routes = $("routes");
  routes.replaceChildren();
  for (const row of summary?.providers ?? []) {
    const item = node("div", null, "route-row");
    item.append(node("span", row.provider, "route-name"), node("span", usd(row.estimatedCostUsd), "route-value"));
    item.append(node("span", `${number(row.requests)} 次 · ${tokens(row.totalTokens)} Token${row.unpricedRequests ? ` · ${number(row.unpricedRequests)} 次费用未知` : ""}`, "route-meta"));
    routes.append(item);
  }
  if (!routes.childElementCount) routes.append(node("p", "此范围暂无线路用量。", "muted"));
  const history = $("history");
  history.replaceChildren();
  for (const row of (isSession ? state.recent : state.recentAll) ?? []) {
    const tr = node("tr");
    const label = node("td", clock(row.timestamp));
    label.append(node("span", `${row.provider} / ${row.servedModel}`, "history-route"));
    tr.append(label, node("td", rate(row.generation)), node("td", percentage(row.cacheRate)), node("td", usd(row.cost.usd)));
    history.append(tr);
  }
  text("sync-time", state.updatedAt ? `同步于 ${clock(state.updatedAt)}` : "尚未同步");
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  try {
    const url = new URL("/api/snapshot", location.origin);
    if (conversation) url.searchParams.set("conversation", conversation);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("read_failed");
    state = await response.json();
    render();
  } catch {
    text("connection", "计量进程未响应，保留上次数据；请重新启动本地计量。");
    $("connection").classList.add("warning");
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}
$("session-tab").addEventListener("click", () => { scope = "session"; render(); });
$("today-tab").addEventListener("click", () => { scope = "today"; render(); });
$("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
void refresh();
