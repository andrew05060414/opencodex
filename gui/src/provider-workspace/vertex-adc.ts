export function isVertexAdcProvider(provider: {
  adapter?: string;
  googleMode?: string;
  keyOptional?: boolean;
  hasApiKey?: boolean;
}): boolean {
  return provider.adapter === "google"
    && provider.googleMode === "vertex"
    && provider.keyOptional === true
    && provider.hasApiKey !== true;
}
