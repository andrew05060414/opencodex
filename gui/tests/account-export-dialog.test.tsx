/**
 * The account credential export dialog, rendered.
 *
 * Three claims matter and each is driven here rather than read from source: the warning is on
 * screen before anything is sent, the operator-paired request downloads the document once, and a
 * refused session says how to get an authorized one instead of looking like a transport failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AccountExportDialog, { type AccountExportOutcome, type ExportAccountRow } from "../src/components/account-export-dialog";
import { accountExportFilename } from "../src/account-export-download";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let downloads: string[] = [];
let createdUrls = 0;
let revokedUrls = 0;
let responses: Array<() => Response> = [];
const requests: Array<{ url: string; method?: string; body?: string }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  const dialogProto = (testWindow as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } }).HTMLDialogElement.prototype;
  dialogProto.showModal = function showModal(this: { open?: boolean }) { this.open = true; };
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  downloads = [];
  createdUrls = 0;
  revokedUrls = 0;
  responses = [];
  requests.length = 0;
  // Anchor clicks are what a browser does for a download; record instead of navigating.
  Object.defineProperty(testWindow.HTMLAnchorElement.prototype, "click", {
    configurable: true,
    value(this: HTMLAnchorElement) { downloads.push(this.download); },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => { createdUrls += 1; return `blob:fixture-${createdUrls}`; },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => { revokedUrls += 1; },
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
    const next = responses.shift();
    if (!next) throw new Error("no fixture response");
    return next();
  }) as typeof fetch;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  globalThis.fetch = originalFetch;
});

function render(onExported: (outcome: AccountExportOutcome) => void = () => {}, onClose: () => void = () => {}): void {
  root ??= createRoot(container);
  act(() => root!.render(
    <LanguageProvider>
      <AccountExportDialog apiBase="http://127.0.0.1:10100" onClose={onClose} onExported={onExported} />
    </LanguageProvider>,
  ));
}

const ACCOUNTS: ExportAccountRow[] = [
  { key: "anthropic:claude-1", provider: "anthropic", group: "anthropic", label: "work" },
  { key: "anthropic:claude-2", provider: "anthropic", group: "anthropic", label: "Account 2" },
  { key: "openai:main", provider: "openai", group: "openai", label: "me@example.com" },
];

function renderWithAccounts(onExported: (outcome: AccountExportOutcome) => void = () => {}): void {
  root ??= createRoot(container);
  act(() => root!.render(
    <LanguageProvider>
      <AccountExportDialog apiBase="http://127.0.0.1:10100" accounts={ACCOUNTS} onClose={() => {}} onExported={onExported} />
    </LanguageProvider>,
  ));
}

const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;
const confirm = () => q<HTMLButtonElement>(".btn-primary")!;
const warning = () => q<HTMLDialogElement>("dialog")!.textContent ?? "";

async function clickConfirm(): Promise<void> {
  await act(async () => { confirm().click(); await Promise.resolve(); });
}

describe("account credential export dialog", () => {
  test("warns about refresh tokens before anything is requested", () => {
    render();
    expect(warning()).toContain(DICTS.en["pws.exportWarning"]);
    expect(warning()).toContain(DICTS.en["pws.exportFormatFullHint"]);
    // Five formats, full selected by default, and no request yet.
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map(radio => radio.checked)).toEqual([true, false, false, false, false]);
    expect(requests).toEqual([]);
  });

  test("a paired session downloads the full document once and reports it", async () => {
    const outcomes: AccountExportOutcome[] = [];
    let closed = 0;
    render(outcome => outcomes.push(outcome), () => { closed += 1; });
    responses.push(() => Response.json({
      version: 1,
      exportedAt: "2026-10-28T00:00:00.000Z",
      oauth: { anthropic: { activeAccountId: "a1", accounts: [] } },
      codex: [],
      omitted: [],
    }));
    await clickConfirm();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:10100/api/oauth/accounts/export");
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ format: "full" });
    expect(downloads).toEqual([accountExportFilename("full")]);
    expect(createdUrls).toBe(1);
    expect(revokedUrls).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: true, filename: accountExportFilename("full"), files: 1 });
    expect(closed).toBe(1);
  });

  test("the Cockpit format sends that choice and accepts the flat array", async () => {
    const outcomes: AccountExportOutcome[] = [];
    render(outcome => outcomes.push(outcome));
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    act(() => radios[3]!.click());
    responses.push(() => Response.json({ format: "cockpit-tools", files: [{ filename: "antigravity-cockpit-tools.json", content: "[]\n" }] }));
    await clickConfirm();
    expect(JSON.parse(requests[0]!.body!)).toEqual({ format: "cockpit-tools" });
    expect(downloads).toEqual(["antigravity-cockpit-tools.json"]);
    expect(outcomes[0]).toMatchObject({ ok: true });
  });

  test("a refused session explains the remedy and downloads nothing", async () => {
    const outcomes: AccountExportOutcome[] = [];
    render(outcome => outcomes.push(outcome));
    responses.push(() => Response.json({ code: "export_session_required" }, { status: 403 }));
    await clickConfirm();
    expect(q('[role="alert"]')?.textContent).toBe(DICTS.en["pws.exportDenied"]);
    expect(downloads).toEqual([]);
    expect(outcomes).toEqual([]);
    // The refusal must be actionable on this machine, not only a dead end.
    expect(warning()).toContain(DICTS.en["pws.exportFallbackHint"]);
    expect(warning()).toContain("ocx account export --file");
  });

  test("an unexpected body is refused rather than downloaded", async () => {
    render();
    responses.push(() => Response.json({ version: 2 }));
    await clickConfirm();
    expect(q('[role="alert"]')?.textContent).toBe(DICTS.en["pws.exportInvalid"]);
    expect(downloads).toEqual([]);
  });

  test("ticking one account sends only that account", async () => {
    const outcomes: AccountExportOutcome[] = [];
    renderWithAccounts(outcome => outcomes.push(outcome));
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(3);
    expect(boxes.every(box => !box.checked)).toBe(true);
    act(() => boxes[0]!.click());
    responses.push(() => Response.json({ version: 1, exportedAt: "x", oauth: {}, codex: [], omitted: [] }));
    await clickConfirm();
    expect(JSON.parse(requests[0]!.body!)).toEqual({ format: "full", selection: { accounts: ["anthropic:claude-1"] } });
    expect(outcomes).toHaveLength(1);
  });

  test("nothing ticked means the whole store", async () => {
    renderWithAccounts();
    responses.push(() => Response.json({ version: 1, exportedAt: "x", oauth: {}, codex: [], omitted: [] }));
    await clickConfirm();
    expect(JSON.parse(requests[0]!.body!)).toEqual({ format: "full" });
  });

  test("a single-credential format needs exactly one account and then downloads that file", async () => {
    renderWithAccounts();
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    act(() => radios[1]!.click()); // codex-auth
    expect(confirm().disabled).toBe(true);
    expect(warning()).toContain(DICTS.en["pws.exportSingleAccountHint"]);
    // Two ticks are still not one.
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    act(() => { boxes[0]!.click(); boxes[1]!.click(); });
    expect(confirm().disabled).toBe(true);
    act(() => boxes[1]!.click());
    expect(confirm().disabled).toBe(false);
    responses.push(() => Response.json({ format: "codex-auth", files: [{ filename: "claude-1.codex-auth.json", content: "{}\n" }] }));
    await clickConfirm();
    expect(downloads).toEqual(["claude-1.codex-auth.json"]);
  });

  test("several files download in one gesture and the receipt counts them", async () => {
    const outcomes: AccountExportOutcome[] = [];
    renderWithAccounts(outcome => outcomes.push(outcome));
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    act(() => radios[4]!.click()); // cliproxyapi
    responses.push(() => Response.json({ format: "cliproxyapi", files: [
      { filename: "codex-main.json", content: "{}\n" },
      { filename: "claude-anthropic-claude-1.json", content: "{}\n" },
    ] }));
    await clickConfirm();
    expect(downloads).toEqual(["codex-main.json", "claude-anthropic-claude-1.json"]);
    expect(outcomes[0]).toMatchObject({ ok: true, files: 2 });
  });
});
