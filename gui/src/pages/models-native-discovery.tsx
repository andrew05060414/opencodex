import { useState } from "react";
import { IconRefresh } from "../icons";
import { useT } from "../i18n/shared";

interface NativeRefreshResponse {
  discovery?: { status?: string; reason?: string } | null;
  newArrivals?: Array<{ id?: unknown }>;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; added: string[] }
  | { kind: "failed"; detail?: string };

/**
 * Manual native GPT discovery for the native group card. Native models come from the ChatGPT/Codex
 * account roster, which only the hourly catalog auto-refresh read before; this asks for it now.
 */
export function NativeModelDiscovery({ apiBase, onCatalogChanged }: { apiBase: string; onCatalogChanged: () => void }) {
  const t = useT();
  const [run, setRun] = useState<RunState>({ kind: "idle" });

  const discover = async () => {
    setRun({ kind: "running" });
    try {
      const response = await fetch(`${apiBase}/api/model-discovery/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ native: true }),
      });
      const json = await response.json().catch(() => null) as NativeRefreshResponse | null;
      if (!response.ok || !json) { setRun({ kind: "failed" }); return; }
      if (json.discovery?.status === "failed") {
        setRun({ kind: "failed", ...(json.discovery.reason ? { detail: json.discovery.reason } : {}) });
        return;
      }
      const added = (json.newArrivals ?? []).flatMap(row => typeof row?.id === "string" ? [row.id] : []);
      setRun({ kind: "done", added });
      if (added.length > 0) onCatalogChanged();
    } catch {
      setRun({ kind: "failed" });
    }
  };

  return (
    <div className="row muted text-label leading-body" style={{ alignItems: "center", flexWrap: "wrap", gap: 8, padding: "4px 0" }}>
      <button type="button" className="btn btn-ghost btn-sm" disabled={run.kind === "running"}
        aria-busy={run.kind === "running"} title={t("modelDiscover.nativeHint")} onClick={() => { void discover(); }}>
        <IconRefresh width={14} height={14} aria-hidden="true" />
        {" "}
        {run.kind === "running" ? t("modelDiscover.running") : t("modelDiscover.nativeNow")}
      </button>
      <span role="status" aria-live="polite">
        {run.kind === "done" && run.added.length > 0 && (
          <>
            {t("modelDiscover.nativeFound", { added: run.added.length })}{" "}
            {run.added.map(id => <code key={id} style={{ marginRight: 6 }}>{id}</code>)}
            {t("modelDiscover.nativeRestart")}
          </>
        )}
        {run.kind === "done" && run.added.length === 0 && t("modelDiscover.nativeNone")}
        {run.kind === "failed" && `${t("modelDiscover.failed")}${run.detail ? ` · ${run.detail}` : ""}`}
      </span>
    </div>
  );
}
