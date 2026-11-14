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
