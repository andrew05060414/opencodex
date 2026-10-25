import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { ClaudeWorkflowSettings } from "../src/components/ClaudeWorkflowSettings";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#claude" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
  return { container, root: root! };
}

test("loads initial state from GET /api/claude-code and displays checkbox", async () => {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/claude-code")) {
      return new Response(JSON.stringify({
        ultracode: true,
        workflowsDisabled: false,
        workflowSettingsPath: "/home/user/.claude/settings.json",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  };

  const { container } = await mount(<ClaudeWorkflowSettings apiBase="http://localhost" />);
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox).not.toBeNull();
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
});

test("omits the workflow card when the server has no workflow capability", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ enabled: true, model: "sonnet" }), {
    headers: { "Content-Type": "application/json" },
  });
  const { container } = await mount(<ClaudeWorkflowSettings apiBase="http://localhost" />);
  expect(container.textContent).toBe("");
});

test("does not request workflow settings for an inactive panel", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 500 }); };
  await mount(<ClaudeWorkflowSettings apiBase="http://localhost" active={false} />);
  expect(calls).toBe(0);
});

test("toggles ultracode and updates state on successful PUT /api/claude-code", async () => {
  let putPayload: any = null;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return new Response(JSON.stringify({
        ultracode: false,
        workflowsDisabled: false,
        workflowSettingsPath: "/home/user/.claude/settings.json",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      putPayload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        ok: true,
        ultracode: true,
        workflowsDisabled: false,
        workflowSettingsPath: "/home/user/.claude/settings.json",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  };

  const { container } = await mount(<ClaudeWorkflowSettings apiBase="http://localhost" />);
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);

  await act(async () => {
    checkbox.click();
  });

  expect(putPayload).toEqual({ ultracode: true });
  expect(checkbox.checked).toBe(true);
});

test("rolls back toggle state on PUT failure", async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return new Response(JSON.stringify({
        ultracode: false,
        workflowsDisabled: false,
        workflowSettingsPath: "/home/user/.claude/settings.json",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      return new Response(JSON.stringify({
        error: "Permission denied or conflict",
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  };

  const { container } = await mount(<ClaudeWorkflowSettings apiBase="http://localhost" />);
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);

  await act(async () => {
    checkbox.click();
  });

  expect(checkbox.checked).toBe(false);
  const errorNotice = container.querySelector(".notice-err");
  expect(errorNotice).not.toBeNull();
  expect(errorNotice?.textContent).toContain("Permission denied or conflict");
});

test("disables checkbox when workflowsDisabled is true or settingsError present", async () => {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    return new Response(JSON.stringify({
      ultracode: false,
      workflowsDisabled: true,
      workflowSettingsPath: "/home/user/.claude/settings.json",
      workflowSettingsError: "Cannot read settings file",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const { container } = await mount(<ClaudeWorkflowSettings apiBase="http://localhost" />);
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  const errorNotice = container.querySelector(".notice-err");
  expect(errorNotice).not.toBeNull();
  expect(errorNotice?.textContent).toContain("Cannot read settings file");
});
