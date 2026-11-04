import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameProvider } from "../../src/server/management/provider-rename";
import type { OcxConfig } from "../../src/types";
import { validateConfigCandidate } from "../../src/config";
import { pickComboTarget } from "../../src/combos/resolve";
import { routeModel } from "../../src/router";
import { handleProviderRename } from "../../src/server/management/provider-rename";
import { saveConfig } from "../../src/config";
import * as atomicWrite from "../../src/config/atomic-write";
import type { ManagementContext } from "../../src/server/management/context";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function config(): OcxConfig {
  return {
    defaultProvider: "old",
    providers: { old: { adapter: "openai-chat", baseUrl: "https://example.com/v1", authMode: "key", apiKey: "test-only" } },
    disabledModels: ["old/hidden", "older/keep"],
    subagentModels: ["old/model"],
    combos: { pick: { strategy: "failover", targets: [{ provider: "old", model: "model" }] } },
    claudeCode: { tierModels: { opus: "old/model" }, desktopProfile: { version: 1, assignments: { "old/model": { family: "opus", alias: "claude-opus-4-8-20260731" } }, defaults: { opus: "old/model", fable: null, sonnet: null, haiku: null } } },
  } as unknown as OcxConfig;
}

test("rename keeps credentials and rewrites routing references together", () => {
  const current = config();
  const validation = validateConfigCandidate(current);
  if (!validation.ok) throw new Error(validation.error);
  renameProvider(current, "old", "new");
  expect(current.providers.old).toBeUndefined();
  expect(current.providers.new?.apiKey).toBe("test-only");
  expect(current.defaultProvider).toBe("new");
  expect(pickComboTarget(current, "pick")?.target.provider).toBe("new");
  expect(routeModel(current, "new/model").providerName).toBe("new");
  expect(current.combos?.pick?.targets[0]?.provider).toBe("new");
  expect(current.subagentModels).toEqual(["new/model"]);
  expect(current.disabledModels).toEqual(["new/hidden", "older/keep"]);
  expect(current.claudeCode?.tierModels?.opus).toBe("new/model");
  expect(current.claudeCode?.desktopProfile?.assignments).toHaveProperty("new/model");
  expect(() => renameProvider(current, "new", "new")).not.toThrow();
});

test("collisions, invalid names and account identities leave config intact", () => {
  for (const destination of ["__proto__", "openai", "old/other"]) {
    const current = config();
    const before = structuredClone(current);
    expect(() => renameProvider(current, "old", destination)).toThrow();
    expect(current).toEqual(before);
  }
  const current = config();
  current.providers.old!.authMode = "oauth";
  const before = structuredClone(current);
  expect(() => renameProvider(current, "old", "new")).toThrow("provider_identity_is_reserved");
  expect(current).toEqual(before);
});

test("durable rename updates live routes, preserves concurrent disk fields and survives save failure", async () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-rename-"));
  process.env.OPENCODEX_HOME = home;
  try {
    const live = config();
    saveConfig(live);
    const file = join(home, "config.json");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.providers.old.note = "concurrent edit";
    writeFileSync(file, JSON.stringify(disk));
    const request = (from: string, to: string) => handleProviderRename({
      config: live,
      req: new Request("http://localhost/api/providers/rename", { method: "POST", body: JSON.stringify({ from, to }) }),
      convergeCodexCatalog: async () => ({}),
    } as unknown as ManagementContext);
    const fail = spyOn(atomicWrite, "atomicWriteFile").mockImplementation(() => { throw new Error("injected save failure"); });
    const before = readFileSync(file, "utf8");
    try { await expect(request("old", "new")).rejects.toThrow("injected save failure"); }
    finally { fail.mockRestore(); }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(live.providers.old).toBeDefined();
    expect(live.providers.new).toBeUndefined();
    expect((await request("old", "new")).status).toBe(200);
    expect(live.providers.new?.note).toBe("concurrent edit");
    expect(live.providers.new?.apiKey).toBe("test-only");
    expect(routeModel(live, "new/model").providerName).toBe("new");
    expect(pickComboTarget(live, "pick")?.target.provider).toBe("new");
    expect(JSON.parse(readFileSync(file, "utf8")).providers.old).toBeUndefined();
    expect((await request("old", "new")).status).toBe(409);
    expect((await request("new", "new")).status).toBe(200);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});
