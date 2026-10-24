import { useState, useEffect, useId } from "react";
import { SettingToggle } from "../pages/claude-code-settings";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";

export interface ClaudeWorkflowData {
  ultracode: boolean;
  workflowsDisabled: boolean;
  workflowSettingsPath: string;
  workflowSettingsError?: string;
}

export function ClaudeWorkflowSettings({
  apiBase,
  onUpdated,
}: {
  apiBase: string;
  onUpdated?: (data: ClaudeWorkflowData) => void;
}) {
  const t = useT();
  const labelId = useId();
  const [data, setData] = useState<ClaudeWorkflowData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetch(`${apiBase}/api/claude-code`, { signal: ctrl.signal })
      .then(res => readJsonOrThrow<ClaudeWorkflowData>(res, t("claude.workflow.fetchError")))
      .then(body => {
        if (cancelled) return;
        if (!body || typeof body.ultracode !== "boolean") {
          throw new Error(t("claude.workflow.fetchError"));
        }
        setData(body);
        setError(null);
        setLoading(false);
        onUpdated?.(body);
      })
      .catch(err => {
        if (cancelled || ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : t("claude.workflow.fetchError"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [apiBase, onUpdated, t]);

  const toggleUltracode = async (nextValue: boolean) => {
    if (pending || !data) return;
    const previous = data.ultracode;
    setData(prev => (prev ? { ...prev, ultracode: nextValue } : prev));
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ultracode: nextValue }),
      });
      const updated = await readJsonOrThrow<ClaudeWorkflowData & { ok?: boolean }>(
        res,
        t("claude.workflow.saveError"),
      );
      if (!updated || typeof updated.ultracode !== "boolean") {
        throw new Error(t("claude.workflow.saveError"));
      }
      setData(updated);
      onUpdated?.(updated);
    } catch (err) {
      setData(prev => (prev ? { ...prev, ultracode: previous } : prev));
      setError(err instanceof Error ? err.message : t("claude.workflow.saveError"));
    } finally {
      setPending(false);
    }
  };

  const isDisabled = loading || pending || !data || data.workflowsDisabled === true || Boolean(data.workflowSettingsError);

  return (
    <div className="card claudecode-connection-card claude-workflow-card">
      <div className="setting-row">
        <div className="setting-label">
          <span className="title" id={labelId}>{t("claude.workflow.label")}</span>
          <span className="desc">{t("claude.workflow.desc")}</span>
          <span className="desc" style={{ color: "var(--muted)", marginTop: 4 }}>
            {t("claude.workflow.scopeNote")}
          </span>
          <span className="desc" style={{ color: "var(--muted)" }}>
            {t("claude.workflow.effectiveNote")}
          </span>
        </div>
        <SettingToggle
          label={t("claude.workflow.label")}
          checked={data?.ultracode === true}
          disabled={isDisabled}
          describedBy={labelId}
          onChange={toggleUltracode}
        />
      </div>
      {data?.workflowsDisabled === true && !data.workflowSettingsError && (
        <Notice tone="warn">{t("claude.workflow.disabledNotice")}</Notice>
      )}
      {data?.workflowSettingsError && (
        <Notice tone="err">
          {t("claude.workflow.settingsError", { error: data.workflowSettingsError })}
        </Notice>
      )}
      {error && (
        <Notice tone="err">{error}</Notice>
      )}
    </div>
  );
}
