import { describe, expect, it } from "bun:test";
import { looksLikeSecretValue, redactClientBody, redactPlainText } from "../../src/privacy";
import {
  fakeGithubToken,
  fakeGoogleApiKey,
  fakeJwt,
  fakeOpenAiKey,
  fakePassword,
  fakePrivateKeyBlock,
} from "../fixtures/privacy/secrets";

// A name that contains key/token/secret only says "might be a credential"; the VALUE decides.
// Values are built at runtime (fixtures/privacy/secrets.ts) so secret scanners never see a literal.
const randomMixed = "q7" + "Zk3" + "Lm9" + "Xp2" + "Rt8" + "Vb4" + "Nw6";
const PLACEHOLDER = /\{\{SECRET_[0-9a-f]{8}\}\}/;

const STATUS_VALUES = [
  "backlog", "in_progress", "started_3", "in_review", "started_9", "started_2", "started_8", "started_4",
  "blocked", "cancelled", "done", "todo", "completed", "triage",
];

describe("name-based credential rule: JSON fields named *key/*token with plain data values are preserved", () => {
  for (const field of ["status_key", "next_status_key", "sort_key", "access_token_type"]) {
    it(`leaves enum / identifier values under "${field}" alone`, () => {
      const body = Object.fromEntries(STATUS_VALUES.map((v, i) => [`${field}_${i}`, v]));
      Object.assign(body, { [field]: "in_progress" });
      const outcome = redactClientBody({ input: [body] });
      expect(outcome.hits).toEqual([]);
      expect(outcome.body).toEqual({ input: [body] });
    });
  }

  it("leaves the same pairs alone when they arrive as JSON text instead of an object", () => {
    for (const v of STATUS_VALUES) {
      const line = `{"status_key": "${v}", "next_status_key": "${v}"}`;
      const outcome = redactPlainText(line);
      expect(outcome.hits).toEqual([]);
      expect(outcome.body).toBe(line);
    }
  });

  it("leaves short <6-char data values and prose under key-named fields alone", () => {
    for (const v of ["2026", "step2", "v1.2"]) {
      expect(redactClientBody({ status_key: v }).hits).toEqual([]);
    }
    const outcome = redactClientBody({ keywords: "refactor the status handler before 3pm" });
    expect(outcome.hits).toEqual([]);
  });
});

describe("name-based credential rule: real token shapes are still masked in any field", () => {
  const realValues: Array<[string, string]> = [
    ["openai key", fakeOpenAiKey("v")],
    ["github token", fakeGithubToken()],
    ["google api key", fakeGoogleApiKey()],
    ["jwt", fakeJwt()],
    ["long random mixed", randomMixed],
    ["8-char hex-ish", "a1b2c3d4"],
    ["16-char hex-ish", "a1b2c3d4".repeat(2)],
    ["long single-case run", "z".repeat(24)],
  ];
  for (const [label, value] of realValues) {
    for (const field of ["status_key", "api_key", "access_token", "client_secret"]) {
      it(`masks ${label} under "${field}" as a JSON field`, () => {
        const outcome = redactClientBody({ [field]: value });
        expect(outcome.hits.length).toBe(1);
        expect(JSON.stringify(outcome.body)).not.toContain(value);
        expect(JSON.stringify(outcome.body)).toMatch(PLACEHOLDER);
      });
    }
  }

  it("masks a PEM block sitting in a key-named field (pattern rules still run on non-secret-shaped prose)", () => {
    const pem = fakePrivateKeyBlock();
    const outcome = redactClientBody({ private_key: pem });
    expect(outcome.hits.some((h) => h.kind === "private_key")).toBe(true);
    expect(JSON.stringify(outcome.body)).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("masks an sk- key embedded in a prose value under a key-named field", () => {
    const key = fakeOpenAiKey("w");
    const outcome = redactClientBody({ status_key: `use ${key} for this` });
    expect(JSON.stringify(outcome.body)).not.toContain(key);
  });

  it("password and secret-named fields stay unconditionally strict, even for plain words", () => {
    expect(redactClientBody({ password: "hunter2x" }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactClientBody({ db_password: "swordfish" }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactClientBody({ client_secret: "correct-horse-word" }).hits).toEqual([{ kind: "api_key", count: 1 }]);
    expect(redactClientBody({ password: fakePassword() }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactPlainText("DB_PASSWORD=hunter2x").hits).toEqual([{ kind: "password", count: 1 }]);
  });

  it("still masks Bearer tokens including mixed-case base64-ish runs", () => {
    expect(redactPlainText("Authorization: Bearer " + randomMixed).hits).toEqual([{ kind: "token", count: 1 }]);
    expect(redactPlainText("Authorization: Bearer " + "AbCdEfGhIjKlMnOpQrStUv").hits).toEqual([{ kind: "token", count: 1 }]);
  });

  it("masks a mixed-class 8-15 char value under a token-named assignment", () => {
    expect(redactPlainText("API_TOKEN=aB3dE6gH").hits).toEqual([{ kind: "token", count: 1 }]);
  });
});

describe("looksLikeSecretValue", () => {
  it("rejects identifier values and accepts secret-shaped ones", () => {
    for (const v of [...STATUS_VALUES, "camelCaseIdentifier"]) {
      expect(looksLikeSecretValue(v, "", "status_key")).toBe(false);
    }
    for (const v of [randomMixed, "a1b2c3d4", "a1b2c3d4a1b2c3d4", "z".repeat(20), "aB3dE6gH"]) {
      expect(looksLikeSecretValue(v, "", "status_key")).toBe(true);
    }
  });

  it("password/secret names never receive the identifier exemption while PWD paths do", () => {
    expect(looksLikeSecretValue("correct-horse-word", "", "db_password")).toBe(true);
    expect(looksLikeSecretValue("correct-horse-word", "", "client_secret")).toBe(true);
    expect(looksLikeSecretValue("~/src/app", "", "PWD")).toBe(false);
  });
});
