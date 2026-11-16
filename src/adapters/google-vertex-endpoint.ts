import { googleVertexLocationConfigError } from "../providers/google-vertex-location";
import { VERTEX_PROJECT_AUTO } from "./google-vertex-key-project";

/**
 * Vertex endpoint selection, shared by inference and replay identity.
 *
 * API keys follow explicit provider configuration only: `provider.project` selects the project
 * endpoint (location defaults to `global`), otherwise the projectless express endpoint is used.
 * `provider.project: "auto"` resolves the project of each key it sends (see
 * google-vertex-key-project.ts), so one key pool may span several projects.
 * ADC with a service-account credential and no explicit project (or `"auto"`) uses that
 * credential's `project_id` (location defaults to `global`).
 * Ambient GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT / GOOGLE_CLOUD_LOCATION belong to ADC, so an
 * unrelated gcloud default in the shell cannot move an express-mode key onto another project.
 */
export type VertexEndpointSelection =
  | { kind: "express" }
  | { kind: "project"; project: string; location: string };

type VertexEndpointConfig = { project?: string; location?: string };

export function selectVertexEndpoint(
  provider: VertexEndpointConfig,
  hasApiKey: boolean,
  env: NodeJS.ProcessEnv = process.env,
  /** `project_id` of the service account this request sends with (gcp-sa marker), if any. */
  credentialProject?: string,
): VertexEndpointSelection {
  // A blank or whitespace-only project is unset: it must not select a /projects/%20/ endpoint.
  const rawProject = provider.project?.trim() || undefined;
  const configuredProject = rawProject?.toLowerCase() === VERTEX_PROJECT_AUTO ? VERTEX_PROJECT_AUTO : rawProject;
  if (hasApiKey) {
    if (!configuredProject) return { kind: "express" };
    return { kind: "project", project: configuredProject, location: provider.location || "global" };
  }
  // A pooled service account bills its own project: unset or "auto" follows the credential's
  // `project_id`, so each SA in a key pool lands on the project it belongs to. An explicit
  // provider.project still wins, and ambient env only fills in when the credential names none.
  if (configuredProject === VERTEX_PROJECT_AUTO && !credentialProject) {
    throw new Error('Vertex AI project "auto" requires an API key or a service-account credential with a project_id; set provider.project to a project id for ADC.');
  }
  const explicitProject = configuredProject === VERTEX_PROJECT_AUTO ? undefined : configuredProject;
  const project = explicitProject || credentialProject || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
  if (!project) throw new Error("Vertex AI requires a project id (provider.project or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT).");
  const location = provider.location || env.GOOGLE_CLOUD_LOCATION || (project === credentialProject ? "global" : undefined);
  if (!location) throw new Error("Vertex AI requires a location (provider.location or GOOGLE_CLOUD_LOCATION).");
  return { kind: "project", project, location };
}

/**
 * Replay namespace for thought-signature continuation; mirrors the endpoint actually used.
 * The endpoint kind is part of the key and the project is encoded, so no configured project
 * (for example one literally named "api-key" or containing ":") can share express mode's space.
 */
export function vertexReplayModelKey(selection: VertexEndpointSelection, modelId: string): string {
  return selection.kind === "express"
    ? `vertex:express:${modelId}`
    : `vertex:project:${encodeURIComponent(selection.project)}:${selection.location}:${modelId}`;
}

const VERTEX_MODEL_PATH_REJECT = /[/?#\\%]/;

/** The model id is interpolated as one URL path segment after a fixed Google authority. */
export function vertexModelPathError(modelId: string): string | undefined {
  if (!modelId || VERTEX_MODEL_PATH_REJECT.test(modelId) || modelId.includes("..")) {
    return "Vertex AI model id must be a single path segment without '/', '?', '#', '\\', '%' or '..'.";
  }
  return undefined;
}

/** Builds the inference URL for a selection; validates location before any authority is formed. */
export function vertexInferenceUrl(selection: VertexEndpointSelection, modelId: string, method: string, streamParam: string): string {
  const modelError = vertexModelPathError(modelId);
  if (modelError) throw new Error(modelError);
  if (selection.kind === "express") {
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:${method}${streamParam}`;
  }
  const locationError = googleVertexLocationConfigError(selection.location);
  if (locationError) throw new Error(locationError);
  const host = selection.location === "global" ? "aiplatform.googleapis.com" : `${selection.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(selection.project)}/locations/${selection.location}/publishers/google/models/${modelId}:${method}${streamParam}`;
}
