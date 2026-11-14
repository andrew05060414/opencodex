import { describe, expect, test } from "bun:test";
import { chooseAntigravityTransport } from "../../../src/adapters/agy-acp/transport";

const enabled = { agyTransport: { enabled: true } };
const disabled = { agyTransport: { enabled: false } };
const none = {};

function requested(value: string): Headers {
  return new Headers({ "x-opencodex-antigravity-transport": value });
}

describe("antigravity transport choice", () => {
  test("the request header overrides a disabled provider flag", () => {
    expect(chooseAntigravityTransport(disabled, requested("agy"))).toBe("agy");
  });

  test("the request header overrides an enabled provider flag", () => {
    expect(chooseAntigravityTransport(enabled, requested("direct"))).toBe("direct");
  });

  test.each(["AGY", " Agy ", "agy"])("the header value %p is read case-insensitively", value => {
    expect(chooseAntigravityTransport(none, requested(value))).toBe("agy");
  });

  test("an unrecognised header value falls back to the provider flag", () => {
    expect(chooseAntigravityTransport(enabled, requested("bogus"))).toBe("agy");
    expect(chooseAntigravityTransport(none, requested("bogus"))).toBe("direct");
  });

  test("without the header, the provider flag decides", () => {
    expect(chooseAntigravityTransport(enabled, new Headers())).toBe("agy");
    expect(chooseAntigravityTransport(disabled, new Headers())).toBe("direct");
  });

  test("the default is direct", () => {
    expect(chooseAntigravityTransport(none)).toBe("direct");
    expect(chooseAntigravityTransport(none, new Headers())).toBe("direct");
  });
});

describe("caller transport header survives the credential header rebuild", () => {
  test("is restored for google-antigravity and nowhere else", async () => {
    const { restoreResponsesClientMetadata } = await import("../../../src/server/responses/core-auth");
    const incoming = new Headers({ authorization: "Bearer caller", "x-opencodex-antigravity-transport": "agy" });

    const antigravity = new Headers({ authorization: "Bearer pool" });
    restoreResponsesClientMetadata(antigravity, incoming, { adapter: "google", googleMode: "cloud-code-assist" } as never);
    expect(antigravity.get("x-opencodex-antigravity-transport")).toBe("agy");
    expect(antigravity.get("authorization")).toBe("Bearer pool");

    const vertex = new Headers({ authorization: "Bearer pool" });
    restoreResponsesClientMetadata(vertex, incoming, { adapter: "google", googleMode: "vertex" } as never);
    expect(vertex.has("x-opencodex-antigravity-transport")).toBe(false);
  });
});
