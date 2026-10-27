/**
 * Privacy page contract.
 *
 * Three things this page must never get wrong, and they are the reason it has tests at all:
 * a redacted value is never rendered (not the allow-list entry the user just typed, not a
 * prefix of one), the range toggle actually re-asks the backend instead of filtering a stale
 * payload, and the three states — populated, empty, switched off — are told apart.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { privacyMockEnabled } from "../src/pages/privacy/privacy-api";
import Privacy from "../src/pages/Privacy";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | undefined;
let container: HTMLElement;
let apiBase: string;
let sequence = 0;
let calls: { url: string; method: string; body: string | undefined }[];

/** What the stats route answers with. Tests reassign it before mounting. */
let statsBody: (range: string) => unknown;
let configBody: { enabled: boolean; allowValues: string[] };
let testBody: unknown;

function populated(range: string) {
  const ts = new Date().toISOString();
  return {
    enabled: true,
    range,
    totals: { masked: range === "30d" ? 1200 : 348, distinctValues: 2, requests: 63 },
    daily: [{ date: "2026-10-21", masked: 4 }, { date: "2026-10-22", masked: 11 }],
    flows: [
      { client: "multica-agent-sdk", provider: "openai", masked: 300 },
      { client: "codex", provider: "anthropic", masked: 48 },
    ],
    requests: [
      {
        id: "r1",
        ts,
        client: "multica-agent-sdk",
        provider: "openai",
        model: "gpt-6.1-sol",
        hits: [{ kind: "password", count: 4 }, { kind: "api_key", count: 2 }],
        total: 6,
      },
    ],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  testWindow.localStorage.setItem("ocx-lang", "en");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  apiBase = `http://privacy-${++sequence}`;
  calls = [];
  statsBody = populated;
  configBody = { enabled: true, allowValues: [] };
  testBody = { masked: "token={{SECRET_1a2b3c4d}}", hits: [{ kind: "token", count: 1 }] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    if (url.includes("/api/privacy/stats")) {
      return json(statsBody(new URL(url).searchParams.get("range") ?? "7d"));
    }
    if (url.includes("/api/privacy/config")) {
      if (method === "PUT") {
        configBody = JSON.parse(body ?? "{}") as typeof configBody;
        return json(configBody);
      }
      return json(configBody);
    }
    if (url.includes("/api/privacy/test")) return json(testBody);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Privacy apiBase={apiBase} /></LanguageProvider>);
  });
}

const statsCalls = () => calls.filter(call => call.url.includes("/api/privacy/stats"));
const buttonBy = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find(node => node.textContent?.trim().startsWith(text));

async function click(button: HTMLButtonElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}

/** React keeps its own copy of the last value it wrote; reset the tracker or onChange no-ops. */
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = Object.getPrototypeOf(field) as object;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    (field as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue("");
    field.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });
}

test("a populated range shows the total, the route and one row per request", async () => {
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("348");
  expect(text).toContain(en["privacy.overview.title"]);
  // The flow names both ends of the route the request took.
  expect(text).toContain("multica-agent-sdk");
  expect(text).toContain("gpt-6.1-sol");
  // One request row, expandable.
  const rows = container.querySelectorAll(".privacy-request-row");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.getAttribute("aria-expanded")).toBe("false");
  await click(rows[0] as HTMLButtonElement);
  expect(container.querySelector(".privacy-request-row")!.getAttribute("aria-expanded")).toBe("true");
});

test("the empty state says nothing has been redacted rather than showing a zero", async () => {
  statsBody = range => ({
    enabled: true,
    range,
    totals: { masked: 0, distinctValues: 0, requests: 0 },
    daily: [],
    flows: [],
    requests: [],
  });
  await mount();
  expect(container.textContent).toContain(en["privacy.empty.noData.title"]);
  expect(container.querySelector(".privacy-request-row")).toBeNull();
});

test("while redaction is off the card offers to turn it on, and the button writes the config", async () => {
  statsBody = range => ({
    enabled: false,
    range,
    totals: { masked: 0, distinctValues: 0, requests: 0 },
    daily: [],
    flows: [],
    requests: [],
  });
  configBody = { enabled: false, allowValues: [] };
  await mount();
  expect(container.textContent).toContain(en["privacy.empty.disabled.title"]);

  await click(buttonBy(en["privacy.empty.disabled.enable"]));
  const write = calls.find(call => call.method === "PUT");
  expect(write?.url).toContain("/api/privacy/config");
  expect(JSON.parse(write!.body!)).toEqual({ enabled: true, allowValues: [] });
});

test("switching 7d to 30d asks the backend again for the new range", async () => {
  await mount();
  expect(statsCalls()).toHaveLength(1);
  expect(statsCalls()[0]!.url).toContain("range=7d");

  await click(buttonBy(en["privacy.range.30d"]));

  expect(statsCalls().length).toBeGreaterThan(1);
  expect(statsCalls().at(-1)!.url).toContain("range=30d");
  expect(container.textContent).toContain("1,200");
});

test("try it posts the text and renders the masked result with its kinds", async () => {
  await mount();
  await click(buttonBy(en["privacy.settings.open"]));

  const field = container.querySelector("textarea") as HTMLTextAreaElement;
  const sample = `token=${"a".repeat(24)}`;
  await typeInto(field, sample);
  await click(buttonBy(en["privacy.test.run"]));

  const posted = calls.find(call => call.url.includes("/api/privacy/test"));
  expect(posted?.method).toBe("POST");
  expect(JSON.parse(posted!.body!)).toEqual({ text: sample });
  expect(container.querySelector(".privacy-test-output")?.textContent).toBe("token={{SECRET_1a2b3c4d}}");
  expect(container.querySelector(".privacy-test-hits")?.textContent).toContain(en["privacy.kind.token"]);
});

test("an added allow value is sent once and never rendered again", async () => {
  await mount();
  await click(buttonBy(en["privacy.settings.open"]));

  const field = container.querySelector(".privacy-settings-form input") as HTMLInputElement;
  // Never typed into a readable control: the box is a password field by construction.
  expect(field.getAttribute("type")).toBe("password");
  const secret = `allow-${"z".repeat(18)}`;
  await typeInto(field, secret);
  await click(buttonBy(en["privacy.settings.allow.add"]));

  const write = calls.find(call => call.method === "PUT");
  expect(JSON.parse(write!.body!).allowValues).toEqual([secret]);
  // The value is gone from the page: not in the text, not in any attribute, not in the input.
  expect(container.textContent).not.toContain(secret);
  expect(container.innerHTML).not.toContain(secret);
  expect((container.querySelector(".privacy-settings-form input") as HTMLInputElement).value).toBe("");
  // What is left is a count.
  expect(container.textContent).toContain(en["privacy.settings.allow.count"].replace("{count}", "1"));
});

test("the by-value tab totals kinds and says why there is nothing else to group by", async () => {
  await mount();
  await click(buttonBy(en["privacy.tab.values"]));
  const values = container.querySelector(".privacy-values")!;
  expect(values.textContent).toContain(en["privacy.kind.password"]);
  expect(values.textContent).toContain(en["privacy.values.note"]);
  expect(container.querySelector(".privacy-request-row")).toBeNull();
});

test("mock data stays behind the dev flag", () => {
  // Production build: the query string cannot reach the fixtures.
  expect(privacyMockEnabled("?mock=1", false)).toBe(false);
  expect(privacyMockEnabled("", true)).toBe(false);
  expect(privacyMockEnabled("?mock=1", true)).toBe(true);
});
