import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { NativeModelDiscovery } from "../src/pages/models-native-discovery";

/** The native GPT group's manual discovery asks the server for the roster, not a provider. */

const DOM_GLOBALS = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousLanguage: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguage = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousLanguage) Object.defineProperty(globalThis.navigator, "language", previousLanguage);
  else delete (globalThis.navigator as { language?: string }).language;
});

async function clickWith(answer: unknown, status = 200) {
  const previous = Object.fromEntries(DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const bodies: unknown[] = [];
  let reloads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/api/model-discovery/refresh")) return new Response(null, { status: 404 });
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answer, { status });
  }) as typeof fetch;
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><NativeModelDiscovery apiBase="http://localhost" onCatalogChanged={() => { reloads++; }} /></LanguageProvider>);
    });
    const button = container.querySelector("button") as unknown as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    return { text: container.textContent ?? "", bodies, reloads };
  } finally {
    await act(async () => { root?.unmount(); });
    for (const key of DOM_GLOBALS) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await testWindow.happyDOM.close();
  }
}

test("new GPT models are listed, the catalog reloads, and a restart is asked for", async () => {
  const result = await clickWith({ ok: true, native: true, discovery: { status: "ok" }, newArrivals: [{ id: "gpt-6.2-astra", at: "2026-11-17T00:00:00Z", state: "enabled" }] });
  expect(result.bodies).toEqual([{ native: true }]);
  expect(result.text).toContain("gpt-6.2-astra");
  expect(result.text).toContain("Restart Codex");
  expect(result.reloads).toBe(1);
});

test("no new models says so without reloading; a failed roster read names the reason", async () => {
  const none = await clickWith({ ok: true, native: true, discovery: { status: "ok", reason: "not_modified" }, newArrivals: [] });
  expect(none.text).toContain("No new GPT models");
  expect(none.reloads).toBe(0);
  const failed = await clickWith({ ok: true, native: true, discovery: { status: "failed", reason: "roster_unavailable" }, newArrivals: [] });
  expect(failed.text).toContain("Discovery failed · roster_unavailable");
});
