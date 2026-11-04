import { useEffect, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";

export default function ModelVisionRefusal({ apiBase, provider, modelId }: {
  apiBase: string; provider: string; modelId: string;
}) {
  const t = useT();
  const [state, setState] = useState<"loading" | "clear" | "marked" | "clearing" | "error">("loading");
  const endpoint = `${apiBase}/api/models/vision-refusal?${new URLSearchParams({ provider, modelId })}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(response => readJsonOrThrow<{ refusal: unknown }>(response))
      .then(result => {
        if (!result || !("refusal" in result)) throw new Error("invalid refusal state");
        if (!controller.signal.aborted) setState(result.refusal ? "marked" : "clear");
      })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [endpoint]);
  const clear = async () => {
    setState("clearing");
    try {
      const receipt = await fetch(endpoint, { method: "DELETE", signal: AbortSignal.timeout(10_000) })
        .then(response => readJsonOrThrow<{ ok: boolean }>(response));
      if (receipt?.ok !== true) throw new Error("invalid receipt");
      setState("clear");
    } catch { setState("error"); }
  };
  if (state === "loading" || state === "clear") return null;
  return <Notice tone="warn">
    <p>{t(state === "error" ? "models.visionRefusalError" : "models.visionRefusal")}</p>
    <button type="button" className="btn" disabled={state === "clearing"} onClick={() => void clear()}>
      {t("models.visionRefusalClear")}
    </button>
  </Notice>;
}
