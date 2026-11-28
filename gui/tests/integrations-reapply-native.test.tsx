import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import IntegrationsOverview from "../src/pages/integrations/IntegrationsOverview";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
type RecordedRequest = { url: string; method: string; body: unknown };
let requests: RecordedRequest[] = [];
let mountCount = 0;
let apiBase = "";

let codexRoutingResponse: () => Response;
let codexDesiredEnabled = true;
/** Claude Desktop reports an applied gateway whose file drifted ("Update needed"); the PUT below clears it. */
let desktopStale = false;
let desktopApplied = false;
let desktopNativeDesiredEnabled = true;
let desktopApplyWarning: "first_party_mode_unsaved" | "gateway_state_unsaved" | undefined;
/** Codex's enable PUT saves intent but its sync does not complete (`apply_incomplete`). */
let codexApplyIncomplete = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function switchFor(clientId: string): HTMLButtonElement | undefined {
  const card = container.querySelector(`[data-client="${clientId}"]`);
  if (!card) return undefined;
  return Array.from(card.querySelectorAll("button")).find(
    button => (button as HTMLButtonElement).className.includes("switch"),
  ) as HTMLButtonElement | undefined;
}

async function mountOverview(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <IntegrationsOverview apiBase={apiBase} active />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: testWindow.document },
    window: { configurable: true, writable: true, value: testWindow },
    navigator: { configurable: true, writable: true, value: testWindow.navigator },
    localStorage: { configurable: true, writable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, writable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });

  requests = [];
  mountCount += 1;
  apiBase = `http://ocx-reapply-native-${mountCount}.invalid`;
  codexRoutingResponse = () => json({ routingInjected: false, status: "native", recommendedCommand: null });
  codexDesiredEnabled = true;
  desktopStale = false;
  desktopApplied = false;
  desktopNativeDesiredEnabled = true;
  desktopApplyWarning = undefined;
  codexApplyIncomplete = false;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/journal")) return json({ operations: [] });
    if (url.includes("/api/startup-health")) return codexRoutingResponse();
    if (url.includes("/api/keys")) return json({ keys: [] });
    if (url.includes("/api/claude-desktop/status")) {
      return json({
        desiredEnabled: true,
        installed: true,
        observedKind: "standard",
        applied: desktopApplied,
        stale: desktopStale,
        activeProfile: null,
        appliedAt: null,
      });
    }
    if (method === "PUT" && url.endsWith("/api/native-integrations/claude-desktop")) {
      if (!desktopApplyWarning) desktopStale = false;
      desktopApplied = true;
      return json({
        ok: true, clientId: "claude-desktop", changed: true, state: "current", desiredEnabled: true,
        message: desktopApplyWarning ? "The server reports an unsaved marker." : "enabled",
        reason: desktopApplyWarning,
      });
    }
    if (method === "PUT" && url.endsWith("/api/native-integrations/codex")) {
      const body = init?.body ? JSON.parse(String(init.body)) as { enabled?: unknown } : {};
      if (codexApplyIncomplete && body.enabled === true) {
        return json({
          ok: true, clientId: "codex", changed: false, state: "absent", desiredEnabled: true,
          message: "Codex intent saved, but applying it did not complete: sync failed",
          reason: "apply_incomplete",
        });
      }
      codexDesiredEnabled = body.enabled === true;
      codexRoutingResponse = () => json({
        routingInjected: codexDesiredEnabled,
        status: "native",
        recommendedCommand: null,
      });
      return json({
        ok: true,
        clientId: "codex",
        changed: true,
        state: codexDesiredEnabled ? "current" : "absent",
        message: codexDesiredEnabled ? "enabled" : "disabled",
        desiredEnabled: codexDesiredEnabled,
      });
    }
    if (method === "GET" && url.includes("/api/native-integrations")) {
      return json({
        clients: [{
          clientId: "codex",
          state: codexDesiredEnabled ? "current" : "absent",
          installed: true,
          configPath: "/tmp/codex/config.toml",
          desiredEnabled: codexDesiredEnabled,
          disableBlocked: null,
        }, {
          clientId: "claude-desktop",
          state: "absent",
          installed: true,
          configPath: "/tmp/desktop",
          desiredEnabled: desktopNativeDesiredEnabled,
          disableBlocked: null,
        }],
      });
    }
    if (url.includes("/api/claude-code")) return json({ enabled: false });
    if (url.includes("/api/grok")) return json({ present: false, models: [] });
    return json({ clients: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("the Update needed pill re-applies a drifted Claude Desktop in one click and says so", async () => {
  desktopStale = true;
  desktopApplied = true;
  await mountOverview();
  const pill = () => container.querySelector<HTMLButtonElement>(
    ".integration-card[data-client='claudeDesktop'] button.integration-badge-action",
  );
  expect(pill()?.textContent?.trim()).toBe("Update needed");
  // A plain, current card keeps its badge a label, not a control.
  expect(container.querySelector(".integration-card[data-client='codex'] button.integration-badge-action")).toBeNull();

  await act(async () => { pill()!.focus(); pill()!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 50)); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.url).toContain("/api/native-integrations/claude-desktop");
  expect(put?.body).toEqual({ enabled: true });
  const card = container.querySelector(".integration-card[data-client='claudeDesktop']")!;
  expect(card.textContent).toContain("was re-applied.");
  expect(card.querySelector(".badge")?.getAttribute("data-integration-state")).toBe("current");
  expect(pill()).toBeNull();
  // The pill the keyboard user pressed is gone; focus lands on the card title, not <body>.
  expect(testWindow.document.activeElement).toBe(card.querySelector(".integration-card-link") as never);
});

test("the Claude Desktop Update needed badge cannot re-enable a client whose native intent is off", async () => {
  desktopStale = true;
  desktopApplied = true;
  desktopNativeDesiredEnabled = false;
  await mountOverview();

  const card = container.querySelector(".integration-card[data-client='claudeDesktop']")!;
  expect(switchFor("claudeDesktop")?.getAttribute("aria-checked")).toBe("true");
  expect(card.textContent).toContain("The profile file changed after it was applied");
  const badge = card.querySelector<HTMLElement>(".badge")!;
  expect(badge.textContent?.trim()).toBe("Update needed");
  expect(card.querySelector("button.integration-badge-action")).toBeNull();
  await act(async () => { badge.click(); });
  expect(requests.some(request => request.method === "PUT")).toBe(false);
});

test.each(["first_party_mode_unsaved", "gateway_state_unsaved"] as const)(
  "a Claude Desktop re-apply with %s warns and refreshes status",
  async (reason) => {
    desktopStale = true;
    desktopApplied = true;
    desktopApplyWarning = reason;
    await mountOverview();
    const card = () => container.querySelector(".integration-card[data-client='claudeDesktop']")!;
    const pill = () => card().querySelector<HTMLButtonElement>("button.integration-badge-action");
    expect(pill()?.textContent?.trim()).toBe("Update needed");

    await act(async () => { pill()!.click(); });
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 50)); });

    const put = requests.findIndex(request => request.method === "PUT" && request.url.endsWith("/api/native-integrations/claude-desktop"));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(requests[put].body).toEqual({ enabled: true });
    expect(requests.slice(put + 1).some(request => request.url.includes("/api/claude-desktop/status"))).toBe(true);
    expect(card().querySelector(".notice-warn")?.textContent).toContain(
      "Claude Desktop settings were applied, but OpenCodex could not save the integration state. The displayed status may be out of date.",
    );
    expect(card().textContent).not.toContain("was re-applied.");
    expect(card().textContent).not.toContain("The server reports an unsaved marker.");
    expect(pill()).not.toBeNull();
  },
);

test("a re-apply whose Codex sync did not complete reports failure, not success", async () => {
  // Routed but reporting an error is what the overview shows as "Update needed" for Codex.
  codexRoutingResponse = () => json({ routingInjected: true, status: "error", recommendedCommand: null });
  codexApplyIncomplete = true;
  await mountOverview();
  const card = () => container.querySelector(".integration-card[data-client='codex']")!;
  const pill = () => card().querySelector<HTMLButtonElement>("button.integration-badge-action");
  expect(pill()?.textContent?.trim()).toBe("Update needed");

  await act(async () => { pill()!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 50)); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.url).toContain("/api/native-integrations/codex");
  expect(card().textContent).toContain("could not be re-applied");
  expect(card().textContent).not.toContain("was re-applied.");
  expect(pill()).not.toBeNull();
});
