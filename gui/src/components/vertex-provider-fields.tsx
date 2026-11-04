import { useT } from "../i18n/shared";
import type { ProviderPayloadForm } from "../provider-payload";
import { AddProviderField } from "./add-provider-modal-field";

export function VertexProviderFields({ form, onChange }: {
  form: ProviderPayloadForm;
  onChange: (form: ProviderPayloadForm) => void;
}) {
  const t = useT();
  return <>
    <label className="modal-field">
      <input type="checkbox" checked={form.vertexAdc === true}
        onChange={event => onChange({ ...form, vertexAdc: event.target.checked })} />
      <span>{t("vertex.localCredentials")}</span>
    </label>
    <AddProviderField label={t("vertex.project")}>
      <input className="input" value={form.project ?? ""}
        onChange={event => onChange({ ...form, project: event.target.value })} />
    </AddProviderField>
    <AddProviderField label={t("vertex.location")}>
      <input className="input" value={form.location ?? ""}
        onChange={event => onChange({ ...form, location: event.target.value })} />
    </AddProviderField>
  </>;
}
