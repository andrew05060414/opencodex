/**
 * The request list: one row per request that had something replaced, grouped by day.
 *
 * A row names the route (client → provider → model), the kinds it hit, and how many
 * replacements it made. Expanding one shows the same counts broken out per kind — which is
 * all the backend keeps, and all this page could show even if it wanted to.
 */
import { useId, useState } from "react";
import { IconChevron } from "../../icons";
import { formatProviderDisplayName } from "../../provider-icons";
import type { Locale, TFn } from "../../i18n/shared";
import { dayHeading, formatTimeOfDay, groupRequestsByDay } from "./privacy-grouping";
import { privacyKindColor, privacyKindKey } from "./privacy-kinds";
import { PrivacyRevealedValueList, type PrivacyRevealActions } from "./privacy-reveal";
import type { PrivacyHit, PrivacyKind, PrivacyRequestRecord, PrivacyRevealedValue } from "./privacy-types";

/** Reveal mode's originals, keyed by the request that carried them, and what a row can do with one. */
export interface PrivacyRequestReveal {
  byRequest: ReadonlyMap<string, readonly PrivacyRevealedValue[]>;
  actions: PrivacyRevealActions;
}

export function PrivacyKindTag({ hit, t }: { hit: PrivacyHit; t: TFn }) {
  return (
    <span className="privacy-tag text-caption">
      <span className="privacy-dot" style={{ background: privacyKindColor(hit.kind) }} aria-hidden="true" />
      {t(privacyKindKey(hit.kind))}
      <span className="privacy-tag-count mono">×{hit.count}</span>
    </span>
  );
}

function PrivacyRequestRow({
  request,
  locale,
  t,
  reveal,
  initiallyOpen,
}: {
  request: PrivacyRequestRecord;
  locale: Locale;
  t: TFn;
  reveal?: PrivacyRequestReveal;
  initiallyOpen: boolean;
}) {
  // Until the user toggles the row it follows `initiallyOpen`, so a value that lands a poll
  // after its request still opens the row in the live view.
  const [userOpen, setOpen] = useState<boolean | null>(null);
  const open = userOpen ?? initiallyOpen;
  const values = reveal?.byRequest.get(request.id) ?? [];
  const detailId = useId();
  const route = `${request.client} → ${formatProviderDisplayName(request.provider, t)}`;
  return (
    <li className={`privacy-request${open ? " privacy-request--open" : ""}`}>
      <button
        type="button"
        className="privacy-request-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <span className="privacy-request-time mono text-label muted">{formatTimeOfDay(request.ts, locale)}</span>
        <span className="privacy-request-route text-control" title={route}>{route}</span>
        <span className="privacy-request-model mono text-label muted" title={request.model}>{request.model}</span>
        <span className="privacy-request-tags">
          {request.hits.map(hit => <PrivacyKindTag key={hit.kind} hit={hit} t={t} />)}
        </span>
        <span className="privacy-request-total mono text-control" title={t("privacy.row.totalTitle")}>{request.total}</span>
        <IconChevron className="privacy-request-chevron" aria-hidden="true" />
      </button>
      <div id={detailId} className="privacy-request-detail" hidden={!open}>
        <ul className="privacy-request-detail-list">
          {request.hits.map(hit => (
            <li key={hit.kind} className="privacy-request-detail-row text-control">
              <span className="privacy-dot" style={{ background: privacyKindColor(hit.kind) }} aria-hidden="true" />
              <span>{t(privacyKindKey(hit.kind))}</span>
              <span className="mono muted">{t("privacy.values.count", { count: hit.count })}</span>
            </li>
          ))}
        </ul>
        {!reveal ? (
          <p className="muted text-caption">{t("privacy.row.noValues")}</p>
        ) : values.length > 0 ? (
          <PrivacyRevealedValueList values={values} actions={reveal.actions} t={t} />
        ) : (
          <p className="muted text-caption">{t("privacy.reveal.noneForRequest")}</p>
        )}
      </div>
    </li>
  );
}

export function PrivacyRequestList({
  requests,
  locale,
  t,
  emptyLabel,
  reveal,
  expanded = false,
}: {
  requests: readonly PrivacyRequestRecord[];
  locale: Locale;
  t: TFn;
  emptyLabel: string;
  reveal?: PrivacyRequestReveal;
  /** Rows that carry an original start open (the live view), so a new value is seen without a click. */
  expanded?: boolean;
}) {
  if (requests.length === 0) {
    return <p className="privacy-list-empty muted text-control">{emptyLabel}</p>;
  }
  const now = new Date();
  return (
    <div className="privacy-groups">
      {groupRequestsByDay(requests).map(group => (
        <section key={group.key} className="privacy-group" aria-label={dayHeading(group.key, group.at, locale, t, now)}>
          <h4 className="privacy-group-head text-label muted">{dayHeading(group.key, group.at, locale, t, now)}</h4>
          <ul className="privacy-request-list">
            {group.rows.map(request => (
              <PrivacyRequestRow
                key={request.id}
                request={request}
                locale={locale}
                t={t}
                reveal={reveal}
                initiallyOpen={expanded && (reveal?.byRequest.has(request.id) ?? false)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The "by value" tab: kinds and counts, aggregated, then each original when reveal mode has them. */
export function PrivacyValueList({
  requests,
  t,
  emptyLabel,
  reveal,
}: {
  requests: readonly PrivacyRequestRecord[];
  t: TFn;
  emptyLabel: string;
  reveal?: { values: readonly PrivacyRevealedValue[]; actions: PrivacyRevealActions };
}) {
  const totals = new Map<PrivacyKind, number>();
  for (const request of requests) {
    for (const hit of request.hits) totals.set(hit.kind, (totals.get(hit.kind) ?? 0) + hit.count);
  }
  const rows = [...totals].sort((left, right) => right[1] - left[1]);
  if (rows.length === 0) {
    return <p className="privacy-list-empty muted text-control">{emptyLabel}</p>;
  }
  const max = Math.max(...rows.map(([, count]) => count));
  return (
    <div className="privacy-values">
      <ul className="privacy-value-list">
        {rows.map(([kind, count]) => (
          <li key={kind} className="privacy-value-row">
            <span className="privacy-dot" style={{ background: privacyKindColor(kind) }} aria-hidden="true" />
            <span className="privacy-value-name text-control">{t(privacyKindKey(kind))}</span>
            <span className="privacy-value-bar" aria-hidden="true">
              <span style={{ width: `${(count / max) * 100}%`, background: privacyKindColor(kind) }} />
            </span>
            <span className="privacy-value-count mono text-control">{t("privacy.values.count", { count })}</span>
          </li>
        ))}
      </ul>
      {reveal ? (
        <section className="privacy-reveal-section" aria-label={t("privacy.reveal.listTitle")}>
          <h4 className="privacy-group-head text-label muted">{t("privacy.reveal.listTitle")}</h4>
          {reveal.values.length > 0
            ? <PrivacyRevealedValueList values={reveal.values} actions={reveal.actions} t={t} />
            : <p className="muted text-caption">{t("privacy.reveal.listEmpty")}</p>}
        </section>
      ) : (
        <p className="muted text-caption">{t("privacy.values.note")}</p>
      )}
    </div>
  );
}
