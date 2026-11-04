import { expect, test } from "bun:test";
import { buildProviderPostBody, type ProviderPayloadForm } from "../src/provider-payload";

const form: ProviderPayloadForm = {
  name: "my-vertex", adapter: "google", baseUrl: "https://aiplatform.googleapis.com",
  authMode: "key", apiKey: "test-only", defaultModel: "gemini-4-argon",
  googleMode: "vertex", vertexAdc: true, project: " my-project ", location: " global ",
};

test("ADC retains Vertex mode after renaming and never sends the hidden API key", () => {
  const body = buildProviderPostBody({ id: "google-vertex" }, form);
  expect(body.name).toBe("my-vertex");
  expect(body.provider).toMatchObject({ googleMode: "vertex", project: "my-project", location: "global" });
  expect(body.provider.apiKey).toBeUndefined();
  expect(body.provider).not.toHaveProperty("vertexAdc");
});

test("switching back to API key mode retains the key", () => {
  expect(buildProviderPostBody({ id: "google-vertex" }, { ...form, vertexAdc: false }).provider.apiKey).toBe("test-only");
});
