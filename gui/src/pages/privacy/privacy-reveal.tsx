/**
 * Reveal mode on the Privacy page: the originals the redactor replaced, for checking false
 * positives, and the one-click "not a secret" that puts a value on the allow list.
 *
 * A value is rendered as dots until the operator asks for it, row by row. Its context snippet
 * contains the value too, so it is dotted out the same way while hidden.
 */
import { useState } from "react";
import { IconEye, IconEyeOff } from "../../icons";
import type { TFn } from "../../i18n/shared";
import { privacyKindColor, privacyKindKey } from "./privacy-kinds";
import type { PrivacyRevealedValue } from "./privacy-types";

/** What a value row needs from the page: is it allowed already, and how to change that. */
export interface PrivacyRevealActions {
  allowedIds: ReadonlySet<string>;
  busy: boolean;
  onAllow: (value: PrivacyRevealedValue) => void;
  onUndo: (value: PrivacyRevealedValue) => void;
}

const DOTS = "••••••••";

function hiddenContext(value: PrivacyRevealedValue): string {
  return value.context.split(value.value).join(DOTS);
}

export function PrivacyRevealedValueRow({ value, actions, t }: { value: PrivacyRevealedValue; actions: PrivacyRevealActions; t: TFn }) {
  const [shown, setShown] = useState(false);
  const allowed = actions.allowedIds.has(value.id);
  return (
    <li className={`privacy-reveal-row${allowed ? " privacy-reveal-row--allowed" : ""}`}>
      <span className="privacy-reveal-kind text-caption">
        <span className="privacy-dot" style={{ background: privacyKindColor(value.kind) }} aria-hidden="true" />
        {t(privacyKindKey(value.kind))}
      </span>
      <code className="privacy-reveal-value mono" data-shown={shown}>{shown ? value.value : DOTS}</code>
      <button
        type="button"
        className="btn btn-ghost btn-sm privacy-reveal-eye"
        aria-pressed={shown}
        aria-label={t(shown ? "privacy.reveal.hide" : "privacy.reveal.show")}
        title={t(shown ? "privacy.reveal.hide" : "privacy.reveal.show")}
        onClick={() => setShown(open => !open)}
      >
        {shown ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
      </button>
      {allowed ? (
        <span className="privacy-reveal-allowed text-caption">
          {t("privacy.reveal.allowed")}
          <button type="button" className="link-btn" disabled={actions.busy} onClick={() => actions.onUndo(value)}>
            {t("privacy.reveal.undo")}
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" disabled={actions.busy} onClick={() => actions.onAllow(value)}>
          {t("privacy.reveal.notSecret")}
        </button>
      )}
      <span className="privacy-reveal-meta text-caption muted">
        <span className="mono privacy-reveal-context">{shown ? value.context : hiddenContext(value)}</span>
        {value.requests > 1 && <span> · {t("privacy.reveal.seenIn", { count: value.requests })}</span>}
      </span>
    </li>
  );
}

export function PrivacyRevealedValueList({ values, actions, t }: { values: readonly PrivacyRevealedValue[]; actions: PrivacyRevealActions; t: TFn }) {
  return (
    <ul className="privacy-reveal-list">
      {values.map(value => <PrivacyRevealedValueRow key={`${value.kind}:${value.id}`} value={value} actions={actions} t={t} />)}
    </ul>
  );
}

/** The line above the lists: how to turn reveal mode on, or that it is on and how to stop it. */
/** Dashboard account emails: masked by default; one switch shows the full address and account name. */
export function PrivacyAccountEmailsBar({ maskEmails, busy, onToggle, t }: { maskEmails: boolean; busy: boolean; onToggle: () => void; t: TFn }) {
  return (
    <div className={`privacy-reveal-bar${maskEmails ? "" : " privacy-reveal-bar--on"}`}>
      <div className="privacy-reveal-bar-copy">
        <p className="text-control">{t(maskEmails ? "privacy.reveal.emailsMaskedLine" : "privacy.reveal.emailsShownLine")}</p>
        <p className="muted text-caption">{t("privacy.reveal.emailsScope")}</p>
      </div>
      <button type="button" className={`btn btn-sm ${maskEmails ? "btn-primary" : "btn-ghost"}`} disabled={busy} onClick={onToggle}>
        {t(maskEmails ? "privacy.reveal.emailsShow" : "privacy.reveal.emailsMask")}
      </button>
    </div>
  );
}

export function PrivacyRevealBar({ reveal, busy, onToggle, t }: { reveal: boolean; busy: boolean; onToggle: () => void; t: TFn }) {
  return (
    <div className={`privacy-reveal-bar${reveal ? " privacy-reveal-bar--on" : ""}`}>
      <div className="privacy-reveal-bar-copy">
        <p className="text-control">{t(reveal ? "privacy.reveal.onLine" : "privacy.reveal.hintOff")}</p>
        <p className="muted text-caption">{t("privacy.reveal.warnMemory")}</p>
      </div>
      <button type="button" className={`btn btn-sm ${reveal ? "btn-ghost" : "btn-primary"}`} disabled={busy} onClick={onToggle}>
        {t(reveal ? "privacy.reveal.turnOff" : busy ? "privacy.reveal.turningOn" : "privacy.reveal.turnOn")}
      </button>
    </div>
  );
}
