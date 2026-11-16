import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { selectVertexEndpoint } from "../../../src/adapters/google-vertex-endpoint";
import { saveConfig } from "../../../src/config";
import { __resetVertexTokenCache, gcpCredentialProjectId, getVertexAccessToken } from "../../../src/lib/gcp-adc";
import { readGcpCredentialFile, resolveGcpCredentialFilePath } from "../../../src/lib/gcp-credential-file";
import { osStoreAccounts } from "../../../src/local-credentials/references";
import { splitCredentialPaste } from "../../../src/providers/api-keys";
import { cleanupRemovedGcpCredentials } from "../../../src/providers/gcp-credential-cleanup";
import { clearKeyCooldowns, isCredentialScoped403, rotateKeyOn401 } from "../../../src/providers/key-failover";
import { setProviderKeychainEntryFactoryForTests } from "../../../src/providers/key-store";
import { routedProviderConfig } from "../../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

/**
 * File-backed `gcp-sa:file:<path>` service accounts in a Vertex key pool: a JSON past the Windows
 * Credential Manager blob limit is referenced in place, every SA routes to its own `project_id`,
 * tokens are cached per credential, and a per-project 403 rotates to the next SA.
 */

let home: string;
let outside: string;
const previous = { home: process.env.OPENCODEX_HOME, dirs: process.env.OPENCODEX_GCP_CREDENTIAL_DIRS, project: process.env.GOOGLE_CLOUD_PROJECT };
let pem = "";
const keychainTouches: string[] = [];

function parsed(modelId = "gemini-3.8-flash"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

/** A realistic-size SA JSON (> 2560 UTF-16LE bytes, the Windows Credential Manager blob limit). */
function writeServiceAccount(dir: string, project: string): string {
  const file = join(dir, `${project}.json`);
  writeFileSync(file, JSON.stringify({
    type: "service_account", project_id: project, private_key_id: `kid-${project}`, private_key: pem,
    client_email: `svc@${project}.iam.gserviceaccount.com`, client_id: "1", token_uri: "https://oauth2.googleapis.com/token",
  }, null, 2));
  return file;
}

function marker(file: string): string {
  return `gcp-sa:file:${file.replaceAll("\\", "/")}`;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-gcp-file-pool-"));
  outside = mkdtempSync(join(tmpdir(), "ocx-gcp-file-outside-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_GCP_CREDENTIAL_DIRS;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  mkdirSync(join(home, "gcp-credentials"));
  if (!pem) {
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    ) as CryptoKeyPair;
    const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
    // Armor assembled at runtime: the key is generated per run, and a literal header trips secret scanners.
    const armor = (edge: string) => `-----${edge} ${"PRIVATE"} KEY-----`;
    pem = `${armor("BEGIN")}\n${Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n")}\n${armor("END")}\n`;
  }
  // Any OS-store access in these tests is a bug: file accounts never touch the keychain.
  keychainTouches.length = 0;
  setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => { keychainTouches.push(`get:${account}`); return null; },
    setPassword: () => { keychainTouches.push(`set:${account}`); },
    deletePassword: () => { keychainTouches.push(`delete:${account}`); return true; },
  }));
  clearKeyCooldowns();
});

afterEach(() => {
  __resetVertexTokenCache();
  setProviderKeychainEntryFactoryForTests(null);
  clearKeyCooldowns();
  for (const [name, value] of [["OPENCODEX_HOME", previous.home], ["OPENCODEX_GCP_CREDENTIAL_DIRS", previous.dirs], ["GOOGLE_CLOUD_PROJECT", previous.project]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  removeTreeWithRetry(home);
  removeTreeWithRetry(outside);
});

describe("gcp-sa:file: credential storage", () => {
  test("a credential larger than the Windows blob limit reads back from the allowed root", () => {
    const file = writeServiceAccount(join(home, "gcp-credentials"), "proj-a");
    const raw = readFileSync(file, "utf8");
    expect(Buffer.byteLength(raw, "utf16le")).toBeGreaterThan(2560);
    const account = marker(file).slice("gcp-sa:".length);
    expect(readGcpCredentialFile(account)).toBe(raw);
    expect(gcpCredentialProjectId(account)).toBe("proj-a");
  });

  test("OPENCODEX_GCP_CREDENTIAL_DIRS admits an external directory in place, without copying", () => {
    const file = writeServiceAccount(outside, "proj-ext");
    const account = marker(file).slice("gcp-sa:".length);
    expect(readGcpCredentialFile(account)).toBeUndefined();
    process.env.OPENCODEX_GCP_CREDENTIAL_DIRS = outside;
    expect(gcpCredentialProjectId(account)).toBe("proj-ext");
  });

  test("paths outside the roots, relative, traversal and non-JSON paths are refused", () => {
    const inside = join(home, "gcp-credentials");
    writeServiceAccount(outside, "proj-x");
    writeFileSync(join(inside, "notes.txt"), "{}");
    const cases = [
      `file:${join(outside, "proj-x.json")}`,
      "file:relative/proj-x.json",
      `file:${inside}/../../${outside.split(/[\\/]/).pop()}/proj-x.json`,
      `file:${join(inside, "notes.txt")}`,
      `file:${join(inside, "missing.json")}`,
    ];
    for (const account of cases) {
      expect("error" in resolveGcpCredentialFilePath(account)).toBe(true);
      expect(readGcpCredentialFile(account)).toBeUndefined();
    }
  });

  test("the file account is not an OS-store account and cleanup never deletes the file", () => {
    const file = writeServiceAccount(join(home, "gcp-credentials"), "proj-a");
    const config = { providers: { v: { apiKey: marker(file), apiKeyPool: [{ id: "a", key: marker(file) }, { id: "b", key: "gcp-sa:p/b" }] } } };
    expect(osStoreAccounts(config)).toEqual(["p/b"]);
    saveConfig({ port: 10199, providers: {} } as unknown as OcxConfig);
    cleanupRemovedGcpCredentials([marker(file), "gcp-sa:p/b"]);
    expect(existsSync(file)).toBe(true);
    // The OS-store account is deleted (and re-read to confirm); the file account is never touched.
    expect(keychainTouches).toContain("delete:p/b");
    expect(keychainTouches.filter(touch => touch.includes("file:"))).toEqual([]);
  });

  test("the key-pool paste path admits an in-bounds file reference and refuses others", () => {
    const file = writeServiceAccount(join(home, "gcp-credentials"), "proj-a");
    expect(splitCredentialPaste(marker(file))).toEqual([marker(file)]);
    writeServiceAccount(outside, "proj-x");
    expect(() => splitCredentialPaste(marker(join(outside, "proj-x.json")))).toThrow(/outside the allowed directories/);
    writeFileSync(join(home, "gcp-credentials", "junk.json"), JSON.stringify({ type: "other" }));
    expect(() => splitCredentialPaste(marker(join(home, "gcp-credentials", "junk.json")))).toThrow(/not a valid/);
    expect(() => splitCredentialPaste(file)).toThrow(/file path/);
    expect(keychainTouches).toEqual([]);
  });
});

describe("vertex project follows the service account", () => {
  test("unset or auto uses the credential project; explicit wins; env only fills a credential gap", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "env-proj" } as NodeJS.ProcessEnv;
    expect(selectVertexEndpoint({ project: "auto" }, false, env, "sa-proj")).toEqual({ kind: "project", project: "sa-proj", location: "global" });
    expect(selectVertexEndpoint({}, false, env, "sa-proj")).toEqual({ kind: "project", project: "sa-proj", location: "global" });
    expect(selectVertexEndpoint({ project: "pinned", location: "us-central1" }, false, env, "sa-proj")).toEqual({ kind: "project", project: "pinned", location: "us-central1" });
    expect(() => selectVertexEndpoint({ project: "auto" }, false, env)).toThrow(/project_id/);
    expect(() => selectVertexEndpoint({}, false, env)).toThrow(/location/);
  });

  test("two pooled SAs build requests for their own projects with separately cached tokens", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "ambient-should-lose";
    const dir = join(home, "gcp-credentials");
    const files = [writeServiceAccount(dir, "proj-a"), writeServiceAccount(dir, "proj-b")];
    const issuers: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8")) as { iss: string };
      issuers.push(claims.iss);
      return new Response(JSON.stringify({ access_token: `tok-${claims.iss.split("@")[1]!.split(".")[0]}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      saveConfig({ port: 10199, providers: {} } as unknown as OcxConfig);
      for (const round of [0, 1]) {
        for (const [index, file] of files.entries()) {
          const project = index === 0 ? "proj-a" : "proj-b";
          const provider = routedProviderConfig("google-vertex", {
            adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", project: round ? "auto" : undefined, apiKey: marker(file),
          } as OcxProviderConfig);
          const req = await createGoogleAdapter(provider).buildRequest(parsed());
          expect(req.url).toContain(`/v1/projects/${project}/locations/global/publishers/google/models/gemini-3.8-flash:`);
          expect(req.headers["Authorization"]).toBe(`Bearer tok-${project}`);
        }
      }
      // One exchange per SA: the second round is served from the per-credential cache.
      expect(issuers.sort()).toEqual(["svc@proj-a.iam.gserviceaccount.com", "svc@proj-b.iam.gserviceaccount.com"]);
      expect(await getVertexAccessToken({ markerAccount: marker(files[0]!).slice("gcp-sa:".length) })).toBe("tok-proj-a");
      expect(keychainTouches).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("vertex SA pool failover", () => {
  test("a 403 is credential-scoped only for a Vertex service-account pool, and rotates to the next SA", () => {
    const dir = join(home, "gcp-credentials");
    const keys = ["proj-a", "proj-b", "proj-c"].map(project => marker(writeServiceAccount(dir, project)));
    const provider = {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", project: "auto",
      apiKey: keys[0], apiKeyPool: keys.map((key, index) => ({ id: `sa${index}`, key, addedAt: index })),
    } as OcxProviderConfig;
    const config = { port: 10199, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as unknown as OcxConfig;
    saveConfig(config);

    expect(isCredentialScoped403(provider, 403)).toBe(true);
    expect(isCredentialScoped403(provider, 400)).toBe(false);
    expect(isCredentialScoped403({ ...provider, googleMode: undefined }, 403)).toBe(false);
    expect(isCredentialScoped403({ ...provider, apiKey: "plain-api-key", apiKeyPool: provider.apiKeyPool!.map(e => ({ ...e, key: `k-${e.id}` })) }, 403)).toBe(false);
    expect(isCredentialScoped403({ ...provider, apiKeyPool: provider.apiKeyPool!.slice(0, 1) }, 403)).toBe(false);

    const now = 1_000_000;
    const first = rotateKeyOn401(config, "google-vertex", now, keys[0]);
    expect(first?.apiKey).toBe(keys[1]);
    const second = rotateKeyOn401(config, "google-vertex", now, keys[1]);
    expect(second?.apiKey).toBe(keys[2]);
    expect(rotateKeyOn401(config, "google-vertex", now, keys[2])).toBeNull();
  });
});
