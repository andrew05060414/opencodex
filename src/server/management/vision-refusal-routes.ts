import { forgetVisionRefusal, visionRefusal } from "../../vision/refusals";
import type { ManagementContext } from "./context";

export function handleVisionRefusalRoutes({ req, url, config }: ManagementContext): Response | null {
  if (url.pathname !== "/api/models/vision-refusal") return null;
  if (req.method !== "GET" && req.method !== "DELETE") return new Response(null, { status: 405 });
  const providerName = url.searchParams.get("provider") ?? "";
  const modelId = url.searchParams.get("modelId") ?? "";
  if (!Object.hasOwn(config.providers, providerName) || !modelId || modelId.length > 512) {
    return Response.json({ error: "provider and modelId are required" }, { status: 400 });
  }
  const provider = config.providers[providerName];
  if (req.method === "DELETE") {
    return Response.json({ ok: true, cleared: forgetVisionRefusal(providerName, provider, modelId) });
  }
  return Response.json({ refusal: visionRefusal(providerName, provider, modelId) ?? null, persistent: false });
}
