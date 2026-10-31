/** Local stdio MCP entrypoint; stdout is reserved for the MCP protocol. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { LedgerMeter } from "./core";
import { loadMeterPrices, meterConversation } from "./server";

const server = new McpServer({ name: "opencodex-meter", version: "0.1.0" });
loadMeterPrices();
let selected = "";
let meter = new LedgerMeter();
let queue = Promise.resolve();
const panelPort = Number(process.env.METER_PORT ?? "18082");

server.registerTool("read_usage", {
  title: "Read OpenCodex speed and usage",
  description: "Read this machine's OpenCodex ledger: latest completed request's estimated generation speed, first-output wait, observed cache and estimated costs. Pass the current Codex thread ID for exact session correlation. Includes third-party routes through OpenCodex. API-equivalent costs are estimates, never actual subscription charges. Does not intercept traffic, change configuration or make model requests.",
  inputSchema: { conversation_id: z.string().max(512).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ conversation_id }) => {
  const conversation = meterConversation(conversation_id ?? "");
  if (conversation === null) return { content: [{ type: "text" as const, text: "Invalid conversation ID." }], isError: true };
  let result: Awaited<ReturnType<typeof read>>;
  async function read() {
    if (conversation !== selected) { selected = conversation!; meter = new LedgerMeter(selected); }
    await meter.refresh();
    const snapshot = meter.snapshot();
    const compact = (data: typeof snapshot.today | null) => data ? {
      requests: data.requests, inputTokens: data.inputTokens, outputTokens: data.outputTokens, totalTokens: data.totalTokens,
      estimatedCostUsd: data.estimatedCostUsd, pricedRequests: data.pricedRequests,
      unpricedRequests: data.unpricedRequests, unmeteredRequests: data.unmeteredRequests,
    } : null;
    return {
      source: snapshot.source, timezone: snapshot.timezone, conversation: snapshot.conversation,
      sourceExists: snapshot.sourceExists, today: compact(snapshot.today), session: compact(snapshot.session),
      latest: snapshot.latest, updatedAt: snapshot.updatedAt,
      billing: "Display-time estimates; subscription cash charges are not available.",
      panelUrl: `http://127.0.0.1:${panelPort}/?conversation=${encodeURIComponent(conversation!)}`,
    };
  }
  const flight = queue.then(async () => { result = await read(); });
  queue = flight.catch(() => {});
  try {
    await flight;
    return { structuredContent: result!, content: [{ type: "text" as const, text: JSON.stringify(result!) }] };
  } catch {
    return { content: [{ type: "text" as const, text: "OpenCodex ledger could not be read." }], isError: true };
  }
});

server.registerTool("open_meter", {
  title: "Open the local OpenCodex meter",
  description: "Ensure the local read-only meter process is running and return its URL for the Codex browser panel. Pass the current thread ID to pin the panel to that conversation. Starts only the meter, never the OpenCodex proxy, and does not register startup or change routing or credentials.",
  inputSchema: { conversation_id: z.string().max(512).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ conversation_id }) => {
  const conversation = meterConversation(conversation_id ?? "");
  if (conversation === null) return { content: [{ type: "text" as const, text: "Invalid conversation ID." }], isError: true };
  const base = `http://127.0.0.1:${panelPort}`;
  async function running(): Promise<"yes" | "no" | "foreign"> {
    try {
      const response = await fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return "foreign";
      const data = await response.json() as { schemaVersion?: number; source?: string };
      return data.schemaVersion === 1 && data.source === "opencodex-local-ledger" ? "yes" : "foreign";
    } catch { return "no"; }
  }
  let status = await running();
  if (status === "foreign") return { content: [{ type: "text" as const, text: "The meter port is occupied by another service. No process was changed." }], isError: true };
  if (status === "no") {
    const child = spawn(process.execPath, [join(import.meta.dir, "server.ts"), "serve"], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, METER_CONVERSATION: conversation },
    });
    const launched = await new Promise<boolean>(resolve => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    });
    if (launched) child.unref();
    for (let i = 0; launched && i < 15 && status === "no"; i++) {
      await Bun.sleep(200);
      status = await running();
    }
  }
  if (status !== "yes") return { content: [{ type: "text" as const, text: "The local meter could not start. Check the runtime and local port." }], isError: true };
  const data = { url: `${base}/?conversation=${encodeURIComponent(conversation)}`, conversation: conversation || null };
  return { structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
});

if (import.meta.main) await server.connect(new StdioServerTransport());
