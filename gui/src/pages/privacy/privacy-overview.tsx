/**
 * The one card that answers the only question this page exists for: how much never left
 * this computer. Everything in it is a count — a big one, two small ones, a bar per day, and
 * the two ends of the route the request took. No value, no prefix of a value, anywhere.
 */
import { useId } from "react";
import { formatProviderDisplayName } from "../../provider-icons";
import { cachedNumberFormat } from "../../intl-formatters";
import type { Locale, TFn } from "../../i18n/shared";
import { flowSides, PRIVACY_RANGES, strandY, wirePath, type FlowSlice } from "./privacy-flow";
import { formatDayLabel } from "./privacy-grouping";
import type { PrivacyDay, PrivacyFlow, PrivacyRange, PrivacyStats } from "./privacy-types";

function PrivacyFlowDiagram({ flows, t }: { flows: readonly PrivacyFlow[]; t: TFn }) {
  const { clients, providers } = flowSides(flows, t("privacy.flow.others"));
  const clientMax = Math.max(1, ...clients.map(row => row.masked));
  const providerMax = Math.max(1, ...providers.map(row => row.masked));
  const side = (rows: FlowSlice[], modifier: string, label: string) => (
    <ul className={`privacy-flow-side privacy-flow-side--${modifier}`} aria-label={label}>
      {rows.map(row => (
        <li key={`${modifier}:${row.name}`} className="privacy-flow-row">
          <span className="privacy-flow-name" title={row.name}>
            {row.rest || modifier === "client" ? row.name : formatProviderDisplayName(row.name, t)}
          </span>
          <span className="privacy-flow-count mono text-label muted">{row.masked}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="privacy-flow">
      {side(clients, "client", t("privacy.flow.clients"))}
      <div className="privacy-flow-wires">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {clients.map((row, index) => (
            <path
              key={`in:${row.name}`}
              d={wirePath(strandY(index, clients.length), false)}
              vectorEffect="non-scaling-stroke"
              strokeWidth={1 + (row.masked / clientMax) * 2}
            />
          ))}
          {providers.map((row, index) => (
            <path
              key={`out:${row.name}`}
              className="privacy-flow-wire--out"
              d={wirePath(strandY(index, providers.length), true)}
              vectorEffect="non-scaling-stroke"
              strokeWidth={1 + (row.masked / providerMax) * 2}
            />
          ))}
        </svg>
        <span className="privacy-flow-hub">
          <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
        </span>
      </div>
      {side(providers, "provider", t("privacy.flow.providers"))}
    </div>
  );
}

function PrivacyDailyChart({ daily, locale, t }: { daily: readonly PrivacyDay[]; locale: Locale; t: TFn }) {
  if (daily.length === 0) return null;
  const max = Math.max(1, ...daily.map(day => day.masked));
  const first = daily[0]!;
  const summary = t("privacy.daily.aria", {
    days: daily.length,
    masked: daily.reduce((sum, day) => sum + day.masked, 0),
  });
  return (
    <div className="privacy-daily">
      <div className="privacy-daily-bars" role="img" aria-label={summary}>
        {daily.map((day, index) => (
          <span
            key={day.date || index}
            className={`privacy-daily-bar${index === daily.length - 1 ? " privacy-daily-bar--today" : ""}`}
            style={{ height: `${Math.max(day.masked === 0 ? 2 : 8, (day.masked / max) * 100)}%` }}
            title={`${day.date} · ${day.masked}`}
          />
        ))}
      </div>
      <div className="privacy-daily-axis text-caption muted">
        <span>{first.date ? formatDayLabel(first.date, locale) : ""}</span>
        <span className="privacy-daily-today">{t("privacy.overview.today")}</span>
      </div>
    </div>
  );
}

export interface PrivacyOverviewProps {
  stats: PrivacyStats | undefined;
  range: PrivacyRange;
  onRange: (range: PrivacyRange) => void;
  onEnable: () => void;
  enabling: boolean;
  locale: Locale;
  t: TFn;
}

export function PrivacyOverview({ stats, range, onRange, onEnable, enabling, locale, t }: PrivacyOverviewProps) {
  const titleId = useId();
  const number = cachedNumberFormat(locale);
  const enabled = stats?.enabled === true;
  const hasData = !!stats && stats.totals.masked > 0;

  return (
    <section className="panel privacy-overview" aria-labelledby={titleId}>
      <div className="privacy-overview-head">
        <div className="privacy-overview-copy">
          <h3 id={titleId} className="text-subtitle font-semibold">{t("privacy.overview.title")}</h3>
          <p className="muted text-control">{t("privacy.overview.sub")}</p>
        </div>
        <div className="usage-segmented" role="group" aria-label={t("privacy.range.label")}>
          {PRIVACY_RANGES.map(choice => (
            <button
              key={choice}
              type="button"
              className={`usage-segmented-btn${range === choice ? " active" : ""}`}
              aria-pressed={range === choice}
              onClick={() => onRange(choice)}
            >
              {t(`privacy.range.${choice}`)}
            </button>
          ))}
        </div>
      </div>

      {!enabled ? (
        <div className="privacy-overview-state">
          <p className="privacy-overview-state-title text-subtitle">{t("privacy.empty.disabled.title")}</p>
          <p className="muted text-control">{t("privacy.empty.disabled.desc")}</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={onEnable} disabled={enabling}>
            {t(enabling ? "privacy.empty.disabled.enabling" : "privacy.empty.disabled.enable")}
          </button>
        </div>
      ) : !hasData ? (
        <div className="privacy-overview-state">
          <p className="privacy-overview-state-title text-subtitle">{t("privacy.empty.noData.title")}</p>
          <p className="muted text-control">{t("privacy.empty.noData.desc")}</p>
        </div>
      ) : (
        <div className="privacy-overview-body">
          <div className="privacy-overview-figures">
            <p className="privacy-big mono">{number.format(stats.totals.masked)}</p>
            <p className="muted text-control privacy-big-unit">{t("privacy.overview.masked")}</p>
            <p className="privacy-overview-small text-control">
              <span><b className="mono">{number.format(stats.totals.distinctValues)}</b> {t("privacy.overview.distinct")}</span>
              <span><b className="mono">{number.format(stats.totals.requests)}</b> {t("privacy.overview.requests")}</span>
            </p>
            <PrivacyDailyChart daily={stats.daily} locale={locale} t={t} />
          </div>
          <div className="privacy-overview-flow">
            <PrivacyFlowDiagram flows={stats.flows} t={t} />
            <p className="privacy-flow-caption text-caption muted">{t("privacy.overview.hereCaption")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
