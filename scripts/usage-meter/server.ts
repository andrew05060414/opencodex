/** Optional standalone local meter. Never starts, reconfigures or proxies an LLM. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigPath } from "../../src/config/paths";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types";
import { LedgerMeter } from "./core";
import { unwrapLogConversationQuery } from "../../src/server/request-log-conversation";

process.env.TZ = process.env.METER_TIMEZONE || "America/New_York";

/** Only pricing fields cross into the estimator; credentials are never returned or copied. */
export function loadMeterPrices(path = getConfigPath()): "loaded" | "missing" | "invalid" {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const providers = Object.fromEntries(Object.entries(raw.providers ?? {}).map(([name, value]) => [name, {
      modelCosts: (value as { modelCosts?: unknown })?.modelCosts,
    }]));
    refreshUserCostOverlays({ providers, codexAccounts: raw.codexAccounts } as OcxConfig);
    return "loaded";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "invalid";
  }
}

export function allowedRequest(request: Request, port: number): boolean {
  const url = new URL(request.url);
  if (url.host !== `127.0.0.1:${port}` && url.host !== `localhost:${port}`) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

export function meterConversation(raw: string): string | null {
  const value = unwrapLogConversationQuery(raw.trim());
  return value === "" || /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

async function main() {
  const command = process.argv[2] ?? "serve";
  if (!["serve", "snapshot"].includes(command)) throw new Error("Usage: bun scripts/usage-meter/server.ts [serve|snapshot]");
  const port = Number(process.env.METER_PORT ?? "18082");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("METER_PORT must be 1024..65535");
  const conversation = process.env.METER_CONVERSATION ?? process.env.CODEX_THREAD_ID ?? "";
  const pricing = loadMeterPrices();
  type View = { meter: LedgerMeter; error: string | null; ready: boolean; lastUsed: number; pending: boolean };
  const views = new Map<string, View>();
  let queue = Promise.resolve();
  const refresh = (view: View) => {
    if (view.pending) return queue;
    view.pending = true;
    queue = queue.then(async () => {
      try {
        await view.meter.refresh();
        view.ready = true;
        view.error = null;
      } catch {
        // Filesystem errors may contain private paths. Expose only a stable error code.
        view.error = "ledger_read_failed";
      } finally { view.pending = false; }
    });
    return queue;
  };
  const newView = (key: string): View => ({ meter: new LedgerMeter(key), error: null, ready: false, lastUsed: Date.now(), pending: false });
  const initial = newView(conversation);
  views.set(conversation, initial);
  if (command === "snapshot") {
    await refresh(initial);
    if (initial.error) throw new Error(initial.error);
    console.log(JSON.stringify({ ...initial.meter.snapshot(), pricing }, null, 2));
    return;
  }
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'self'",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(request) {
      if (!allowedRequest(request, port)) return new Response("Forbidden", { status: 403, headers });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
      const url = new URL(request.url);
      if (url.pathname === "/api/snapshot") {
        const key = meterConversation(url.searchParams.get("conversation") ?? conversation);
        if (key === null) return Response.json({ error: "invalid_conversation" }, { status: 400, headers });
        let view = views.get(key);
        if (!view) {
          if (views.size >= 2) {
            const evict = [...views.entries()].filter(([, item]) => !item.pending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            if (!evict) return Response.json({ error: "meter_busy" }, { status: 503, headers });
            views.delete(evict[0]);
          }
          view = newView(key);
          views.set(key, view);
          void refresh(view);
        }
        view.lastUsed = Date.now();
        return Response.json({ ...view.meter.snapshot(), ready: view.ready, error: view.error, pricing }, { headers });
      }
      const staticFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const file = staticFiles[url.pathname];
      if (!file) return new Response("Not found", { status: 404, headers });
      return new Response(Bun.file(join(import.meta.dir, file[0])), { headers: { ...headers, "Content-Type": file[1] } });
    },
  });
  console.log(`OpenCodex meter: http://127.0.0.1:${server.port}`);
  await refresh(initial);
  const timer = setInterval(() => {
    for (const view of views.values()) if (Date.now() - view.lastUsed < 300_000) void refresh(view);
  }, 2000);
  process.on("SIGINT", () => { clearInterval(timer); server.stop(); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(timer); server.stop(); process.exit(0); });
}

if (import.meta.main) {
  main().catch(() => { console.error("Meter could not start. Check the ledger, configuration and local port."); process.exitCode = 1; });
}
