/**
 * Settings: the switch, the allow-list, and a scratchpad for trying the redactor.
 *
 * The allow-list is the one place a real secret is typed into this page, and it is now the only
 * place one exists at all: the server keeps the value, and every route answers with `{ id,
 * length }` instead. So the draft is the whole lifetime of a secret here — it goes into one
 * POST body and is cleared — and the list below can only render a length and four hex digits,
 * because that is all it is given.
 */
import { useId, useState } from "react";
import { Notice, Switch } from "../../ui";
import type { TFn } from "../../i18n/shared";
import {
  addPrivacyAllowValue,
  deletePrivacyAllowValue,
  PRIVACY_ALLOW_VALUE_MAX_LENGTH,
  runPrivacyTest,
  savePrivacyEnabled,
} from "./privacy-api";
import { PrivacyKindTag } from "./privacy-requests";
import type { PrivacyConfig, PrivacyTestResult } from "./privacy-types";

/** Enough to tell two entries apart in a list this short, and far too little to be a clue. */
const ID_DIGITS = 4;

export interface PrivacySettingsProps {
  apiBase: string;
  config: PrivacyConfig;
  onSaved: (next: PrivacyConfig) => void;
  t: TFn;
}

export function PrivacySettings({ apiBase, config, onSaved, t }: PrivacySettingsProps) {
  const allowId = useId();
  const allowListId = useId();
  const testId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowDraft, setAllowDraft] = useState("");
  const [allowOpen, setAllowOpen] = useState(false);
  const [testDraft, setTestDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PrivacyTestResult | null>(null);

  /**
   * `failureText` is the localized copy for a write whose failure has its own wording. The
   * allow-list passes it so a failed add or remove always reads in the UI language; a server's
   * own error text is English and would otherwise be shown as-is.
   */
  const write = async (run: () => Promise<PrivacyConfig>, failureText?: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await run());
    } catch (cause) {
      setError(failureText ?? (cause instanceof Error && cause.message ? cause.message : t("privacy.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const tooLong = allowDraft.trim().length > PRIVACY_ALLOW_VALUE_MAX_LENGTH;
  const canAdd = allowDraft.trim().length > 0 && !tooLong;

  const addAllowValue = async () => {
    const value = allowDraft.trim();
    if (!canAdd || saving) return;
    // Cleared before the request resolves: a failed write must not leave the value readable
    // on screen, and there is nothing to restore it from afterwards by design.
    setAllowDraft("");
    setAllowOpen(true);
    await write(
      () => addPrivacyAllowValue(apiBase, value, t("privacy.settings.allow.addFailed")),
      t("privacy.settings.allow.addFailed"),
    );
  };

  const runTest = async () => {
    if (testing || !testDraft) return;
    setTesting(true);
    setError(null);
    try {
      setResult(await runPrivacyTest(apiBase, testDraft, t("privacy.testFailed")));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error && cause.message ? cause.message : t("privacy.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel privacy-settings" aria-label={t("privacy.settings.title")}>
      <div className="privacy-settings-row">
        <div className="privacy-settings-copy">
          <p className="text-control font-medium">{t("privacy.settings.enable")}</p>
          <p className="muted text-caption">{t("privacy.settings.enableHint")}</p>
        </div>
        <Switch
          on={config.enabled}
          disabled={saving}
          label={t("privacy.settings.enable")}
          onClick={() => { void write(() => savePrivacyEnabled(apiBase, !config.enabled, t("privacy.saveFailed"))); }}
        />
      </div>

      <div className="privacy-settings-block">
        <label className="field-label" htmlFor={allowId}>{t("privacy.settings.allow.title")}</label>
        <div className="privacy-allow-head">
          {config.allowValues.length === 0 ? (
            <p className="muted text-caption">{t("privacy.settings.allow.empty")}</p>
          ) : (
            <button
              type="button"
              className="link-btn text-caption"
              aria-expanded={allowOpen}
              aria-controls={allowListId}
              onClick={() => setAllowOpen(open => !open)}
            >
              {t("privacy.settings.allow.count", { count: config.allowValues.length })}
              <span className="privacy-allow-toggle">
                {t(allowOpen ? "privacy.settings.allow.hide" : "privacy.settings.allow.show")}
              </span>
            </button>
          )}
        </div>
        {config.allowValues.length > 0 && (
          <ul id={allowListId} className="privacy-allow-list" hidden={!allowOpen}>
            {config.allowValues.map(entry => {
              const shortId = entry.id.slice(0, ID_DIGITS);
              return (
                <li key={entry.id} className="privacy-allow-row">
                  <span className="text-control">{t("privacy.settings.allow.length", { length: entry.length })}</span>
                  <code className="privacy-allow-id" title={t("privacy.settings.allow.idLabel")}>{shortId}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={saving}
                    aria-label={t("privacy.settings.allow.removeOne", { id: shortId })}
                    onClick={() => {
                      void write(
                        () => deletePrivacyAllowValue(apiBase, entry.id, t("privacy.settings.allow.removeFailed")),
                        t("privacy.settings.allow.removeFailed"),
                      );
                    }}
                  >
                    {t("privacy.settings.allow.remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="privacy-settings-form"
          onSubmit={event => { event.preventDefault(); void addAllowValue(); }}
        >
          <input
            id={allowId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={allowDraft}
            placeholder={t("privacy.settings.allow.placeholder")}
            onChange={event => setAllowDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={saving || !canAdd}>
            {t("privacy.settings.allow.add")}
          </button>
        </form>
        <p className={tooLong ? "text-caption privacy-allow-error" : "muted text-caption"}>
          {tooLong
            ? t("privacy.settings.allow.tooLong", { max: PRIVACY_ALLOW_VALUE_MAX_LENGTH })
            : t("privacy.settings.allow.note")}
        </p>
      </div>

      <div className="privacy-settings-block">
        <label className="field-label" htmlFor={testId}>{t("privacy.test.title")}</label>
        <textarea
          id={testId}
          className="input privacy-test-input"
          rows={3}
          spellCheck={false}
          value={testDraft}
          placeholder={t("privacy.test.placeholder")}
          onChange={event => setTestDraft(event.target.value)}
        />
        <div className="privacy-settings-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={testing || testDraft.trim().length === 0}
            onClick={() => { void runTest(); }}
          >
            {t(testing ? "privacy.test.running" : "privacy.test.run")}
          </button>
          <span className="muted text-caption">{t("privacy.test.note")}</span>
        </div>
        {result && (
          <div className="privacy-test-result">
            <p className="field-label">{t("privacy.test.result")}</p>
            <pre className="privacy-test-output mono text-label">{result.masked}</pre>
            <div className="privacy-test-hits">
              {result.hits.length === 0
                ? <span className="muted text-caption">{t("privacy.test.none")}</span>
                : result.hits.map(hit => <PrivacyKindTag key={hit.kind} hit={hit} t={t} />)}
            </div>
          </div>
        )}
      </div>

      {error && <Notice tone="err">{error}</Notice>}
    </section>
  );
}
