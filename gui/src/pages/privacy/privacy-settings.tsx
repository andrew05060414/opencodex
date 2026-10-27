/**
 * Settings: the switch, the allow-list, and a scratchpad for trying the redactor.
 *
 * The allow-list is the one place a real secret is typed into this page, so it is also the one
 * place with a rule: the value goes straight into the write and is never rendered again. What
 * the user sees afterwards is a count. The backend returns the values (the page has to send
 * them back on the next write), so "never rendered" is a property of this file, kept here
 * rather than argued about per element.
 */
import { useId, useState } from "react";
import { Notice, Switch } from "../../ui";
import type { TFn } from "../../i18n/shared";
import { runPrivacyTest, savePrivacyConfig } from "./privacy-api";
import { PrivacyKindTag } from "./privacy-requests";
import type { PrivacyConfig, PrivacyTestResult } from "./privacy-types";

export interface PrivacySettingsProps {
  apiBase: string;
  config: PrivacyConfig;
  onSaved: (next: PrivacyConfig) => void;
  t: TFn;
}

export function PrivacySettings({ apiBase, config, onSaved, t }: PrivacySettingsProps) {
  const allowId = useId();
  const testId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowDraft, setAllowDraft] = useState("");
  const [testDraft, setTestDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PrivacyTestResult | null>(null);

  const write = async (next: PrivacyConfig) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await savePrivacyConfig(apiBase, next, t("privacy.saveFailed")));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("privacy.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const addAllowValue = async () => {
    const value = allowDraft.trim();
    if (!value || saving) return;
    // Clear first: the draft must not survive a failed write as readable text on screen.
    setAllowDraft("");
    await write({ ...config, allowValues: [...config.allowValues, value] });
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
          onClick={() => { void write({ ...config, enabled: !config.enabled }); }}
        />
      </div>

      <div className="privacy-settings-block">
        <label className="field-label" htmlFor={allowId}>{t("privacy.settings.allow.title")}</label>
        <p className="muted text-caption">{t("privacy.settings.allow.count", { count: config.allowValues.length })}</p>
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
          <button type="submit" className="btn btn-ghost btn-sm" disabled={saving || !allowDraft.trim()}>
            {t("privacy.settings.allow.add")}
          </button>
        </form>
        <p className="muted text-caption">{t("privacy.settings.allow.note")}</p>
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
