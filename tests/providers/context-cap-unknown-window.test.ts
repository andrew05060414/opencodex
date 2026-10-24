import { describe, expect, test } from "bun:test";
import {
  applyProviderContextCap,
  resolveUnknownRoutedContextWindow,
} from "../../src/providers/context-cap";

describe("unknown routed context windows", () => {
  test("an enabled cap fills a missing window instead of inventing 128k", () => {
    expect(resolveUnknownRoutedContextWindow(350_000)).toBe(350_000);
    expect(applyProviderContextCap(undefined, 350_000)).toBeUndefined();
  });

  test("a discovered window is only lowered", () => {
    expect(applyProviderContextCap(128_000, 350_000)).toBe(128_000);
    expect(applyProviderContextCap(500_000, 350_000)).toBe(350_000);
  });

  test("no cap keeps the 200k fallback", () => {
    expect(resolveUnknownRoutedContextWindow(undefined)).toBe(200_000);
  });

  test("a fractional cap that floors to zero does not invent a zero window", () => {
    expect(resolveUnknownRoutedContextWindow(0.5)).toBe(200_000);
  });
});


test("the unknown window fallback is configurable independently of caps", () => {
  expect(resolveUnknownRoutedContextWindow(undefined, 240_000)).toBe(240_000);
  expect(resolveUnknownRoutedContextWindow(100_000, 240_000)).toBe(100_000);
});
