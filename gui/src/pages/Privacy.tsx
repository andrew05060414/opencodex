/**
 * Privacy — what request redaction kept on this computer.
 *
 * The page reads the three contract routes (`/api/privacy/stats`, `/config`, `/test`) and
 * shows counts only: a record carries a kind and a number, never a value, so there is nothing
 * here that could leak the thing the feature exists to protect. The Live tab is the same stats
 * request on a three-second poll, not a second source of truth.
 */
import { useMemo, useState } from "react";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import { Notice } from "../ui";
import { useI18n } from "../i18n/shared";
import { fetchPrivacyConfig, fetchPrivacyStats, savePrivacyConfig } from "./privacy/privacy-api";
import { privacyKindColor, privacyKindKey, PRIVACY_KINDS } from "./privacy/privacy-kinds";
import { PrivacyOverview } from "./privacy/privacy-overview";
import { PrivacyRequestList, PrivacyValueList } from "./privacy/privacy-requests";
import { PrivacySettings } from "./privacy/privacy-settings";
import type { PrivacyConfig, PrivacyKind, PrivacyRange, PrivacyStats } from "./privacy/privacy-types";
import "./privacy/privacy.css";

const TABS = ["requests", "values", "live"] as const;
type PrivacyTab = (typeof TABS)[number];

/** Live is the same request on a timer; 3s is the cadence the page is specified at. */
const LIVE_POLL_MS = 3_000;

const EMPTY_CONFIG: PrivacyConfig = { enabled: false, allowValues: [] };

export default function Privacy({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<PrivacyRange>("7d");
  const [tab, setTab] = useState<PrivacyTab>("requests");
  const [kindFilter, setKindFilter] = useState<PrivacyKind | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The last write's answer outranks the cached read until the next load settles. */
  const [savedConfig, setSavedConfig] = useState<PrivacyConfig | null>(null);
  const [enabling, setEnabling] = useState(false);

  const statsResource = useDataSurface<PrivacyStats>(
    `privacy-stats:${apiBase}:${range}`,
    [apiBase, range],
    signal => fetchPrivacyStats(apiBase, range, signal, t("privacy.loadFailed")),
    {
      isEmpty: data => data.requests.length === 0,
      pollMs: tab === "live" ? LIVE_POLL_MS : undefined,
    },
  );
  const configResource = useDataSurface<PrivacyConfig>(
    `privacy-config:${apiBase}`,
    [apiBase],
    signal => fetchPrivacyConfig(apiBase, signal, t("privacy.loadFailed")),
    { isEmpty: () => false },
  );

  const stats = statsResource.state.data;
  const config = savedConfig ?? configResource.state.data ?? EMPTY_CONFIG;
  // Both routes report the switch. A write answers for it until the next stats load lands.
  const enabled = savedConfig ? savedConfig.enabled : stats?.enabled ?? config.enabled;
  const view = stats ? { ...stats, enabled } : undefined;

  const requests = useMemo(() => stats?.requests ?? [], [stats]);
  const kindCounts = useMemo(() => {
    const counts = new Map<PrivacyKind, number>();
    for (const request of requests) {
      for (const hit of request.hits) counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + hit.count);
    }
    return counts;
  }, [requests]);
  const totalHits = useMemo(
    () => [...kindCounts.values()].reduce((sum, count) => sum + count, 0),
    [kindCounts],
  );
  const visibleRequests = useMemo(
    () => (kindFilter ? requests.filter(request => request.hits.some(hit => hit.kind === kindFilter)) : requests),
    [requests, kindFilter],
  );

  const handleEnable = async () => {
    if (enabling) return;
    setEnabling(true);
    try {
      setSavedConfig(await savePrivacyConfig(apiBase, { ...config, enabled: true }, t("privacy.saveFailed")));
      statsResource.refresh();
    } catch {
      // The settings panel owns reporting; opening it puts the failure next to the control.
      setSettingsOpen(true);
    } finally {
      setEnabling(false);
    }
  };

  const listEmptyLabel = kindFilter ? t("privacy.list.emptyFiltered") : t("privacy.list.empty");

  return (
    <section className="privacy-page">
      <div className="page-head">
        <h2>{t("privacy.title")}</h2>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(open => !open)}
          >
            {t(settingsOpen ? "privacy.settings.hide" : "privacy.settings.open")}
          </button>
        </div>
      </div>
      <p className="page-sub">{t("privacy.sub")}</p>

      {settingsOpen && (
        <PrivacySettings apiBase={apiBase} config={config} onSaved={setSavedConfig} t={t} />
      )}

      {statsResource.state.showError && (
        <Notice tone="err">
          {statsResource.state.error instanceof Error && statsResource.state.error.message
            ? statsResource.state.error.message
            : t("privacy.loadFailed")}
        </Notice>
      )}

      {statsResource.state.showSkeleton ? (
        <DataSurfaceSkeleton label={t("privacy.loading")} rows={4} />
      ) : (
        <>
          <PrivacyOverview
            stats={view}
            range={range}
            onRange={setRange}
            onEnable={() => { void handleEnable(); }}
            enabling={enabling}
            locale={locale}
            t={t}
          />

          {enabled && requests.length > 0 && (
            <>
              <div className="privacy-toolbar">
                <div className="usage-segmented" role="group" aria-label={t("privacy.tabs.label")}>
                  {TABS.map(choice => (
                    <button
                      key={choice}
                      type="button"
                      className={`usage-segmented-btn${tab === choice ? " active" : ""}`}
                      aria-pressed={tab === choice}
                      onClick={() => setTab(choice)}
                    >
                      {choice === "live" && (
                        <span
                          className={`privacy-live-dot${tab === "live" ? " privacy-live-dot--on" : ""}`}
                          aria-hidden="true"
                        />
                      )}
                      {t(`privacy.tab.${choice}`)}
                    </button>
                  ))}
                </div>
                {tab === "live" && (
                  <span className="privacy-live-status text-caption muted">
                    <span className="privacy-live-dot privacy-live-dot--on" aria-hidden="true" />
                    {t("privacy.live.on")}
                  </span>
                )}
              </div>

              {tab !== "values" && (
                <div className="privacy-filters" role="group" aria-label={t("privacy.filter.label")}>
                  <button
                    type="button"
                    className={`privacy-filter${kindFilter === null ? " active" : ""}`}
                    aria-pressed={kindFilter === null}
                    onClick={() => setKindFilter(null)}
                  >
                    {t("privacy.filter.all")} <span className="mono">{totalHits}</span>
                  </button>
                  {PRIVACY_KINDS.filter(kind => kindCounts.has(kind)).map(kind => (
                    <button
                      key={kind}
                      type="button"
                      className={`privacy-filter${kindFilter === kind ? " active" : ""}`}
                      aria-pressed={kindFilter === kind}
                      onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
                    >
                      <span className="privacy-dot" style={{ background: privacyKindColor(kind) }} aria-hidden="true" />
                      {t(privacyKindKey(kind))} <span className="mono">{kindCounts.get(kind)}</span>
                    </button>
                  ))}
                </div>
              )}

              {statsResource.state.refreshing && (
                <DataSurfaceStatus live={!statsResource.state.showError}>{t("privacy.loading")}</DataSurfaceStatus>
              )}

              {tab === "values" ? (
                <PrivacyValueList requests={requests} t={t} emptyLabel={listEmptyLabel} />
              ) : (
                <PrivacyRequestList requests={visibleRequests} locale={locale} t={t} emptyLabel={listEmptyLabel} />
              )}

              <p className="privacy-footnote muted text-caption">{t("privacy.footnote")}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
