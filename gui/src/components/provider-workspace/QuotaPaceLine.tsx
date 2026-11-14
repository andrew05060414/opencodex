import { useT } from "../../i18n/shared";
import { formatCountdown } from "../../provider-workspace/account-quota-table";
import { formatPace, quotaEta, quotaPace, type QuotaWindowKind } from "../../provider-workspace/quota-pace";

/**
 * The projection line under one quota bar: when the window runs out at the current average rate,
 * and the pace (share used minus share of the window elapsed). Renders nothing when neither can be
 * computed, for example when the window has no reset time or too little time has passed.
 */
export function QuotaPaceLine({ kind, remaining, resetAt, now }: {
  kind: QuotaWindowKind;
  remaining: number;
  resetAt?: number;
  now: number;
}) {
  const t = useT();
  const input = { window: kind, remaining, resetAt };
  const eta = quotaEta(input, now);
  const pace = quotaPace(input, now);
  if (!eta && pace === null) return null;
  const etaText = !eta ? null
    : eta.kind === "runsOut" ? t("acctTable.eta.runsOut", { time: formatCountdown(eta.at, now) })
    : eta.kind === "lasts" ? t("acctTable.eta.lasts")
    : t("acctTable.eta.exhausted");
  const etaTitle = eta?.kind === "runsOut" ? new Date(eta.at).toLocaleString() : undefined;
  return (
    <span className="aqt-bar-eta">
      {etaText && <span title={etaTitle}>{etaText}</span>}
      {etaText && pace !== null && <span aria-hidden="true"> · </span>}
      {pace !== null && <span title={t("acctTable.paceHint")}>{t("acctTable.pace", { delta: formatPace(pace) })}</span>}
    </span>
  );
}
