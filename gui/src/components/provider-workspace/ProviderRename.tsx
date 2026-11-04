import { useState } from "react";
import { useT } from "../../i18n/shared";
import { openProviderSettings } from "../../protocol-deep-links";
import { createBoundedFetch } from "../../bounded-fetch";

export function ProviderRename({ name, apiBase, disabled }: { name: string; apiBase?: string; disabled?: boolean }) {
  const t = useT();
  const [next, setNext] = useState(name);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(false);
    const bounded = createBoundedFetch(30_000);
    try {
      const response = await fetch(`${apiBase ?? ""}/api/providers/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: name, to: next.trim() }),
        signal: bounded.signal,
      });
      if (!response.ok) { setError(true); return; }
      openProviderSettings(next.trim());
      window.location.reload();
    } catch { setError(true); }
    finally { bounded.clear(); setSaving(false); }
  };
  return <div className="pwi-settings-field">
    <label className="pwi-settings-label" htmlFor="provider-rename">{t("modal.providerName")}</label>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {editing ? (
        <input id="provider-rename" className="input" value={next} disabled={saving} onChange={event => setNext(event.target.value)} />
      ) : (
        <input id="provider-rename" className="input" value={name} readOnly disabled />
      )}
      <button className="btn btn-ghost" type="button" disabled={disabled || saving || (editing && (!next.trim() || next.trim() === name))} onClick={() => { if (editing) void save(); else setEditing(true); }}>{editing ? t("common.save") : t("provider.rename")}</button>
    </div>
    {error && <p role="alert">{t("provider.renameFailed")}</p>}
  </div>;
}
