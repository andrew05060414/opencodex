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
// Values are built at runtime (fixtures/secrets.ts) so the gitleaks pre-commit hook never sees a literal.
const randomMixed = "q7" + "Zk3" + "Lm9" + "Xp2" + "Rt8" + "Vb4" + "Nw6";
const PLACEHOLDER = /\{\{SECRET_[0-9a-f]{8}\}\}/;

const STATUS_VALUES = [
  "backlog", "in_progress", "started_3", "in_review", "started_9", "started_2", "started_8", "started_4",
  "blocked", "cancelled", "done", "todo", "completed", "triage",
];

describe("name-based credential rule: a JSON field named *key/*token/*secret with a plain data value is not a secret", () => {
  for (const field of ["status_key", "next_status_key", "sort_key", "access_token_type", "secret_santa"]) {
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

  it("leaves short digit-bearing data values, counters, versions and dates alone", () => {
    for (const v of ["2026", "12345678", "v1.22.333", "1.2.3-beta.1", "2026-11-14", "2026-11-14T10:42:00Z", "step2", "abc123", "a1b2c3d4", "~/.ssh/id_ed25519", "/home/andrew/keys/id_rsa2", "L643-669"]) {
      const outcome = redactClientBody({ status_key: v, token_expires_at: v });
      expect(outcome.hits).toEqual([]);
    }
  });

  it("leaves a prose value under a credential-looking name alone", () => {
    const outcome = redactClientBody({ keywords: "refactor the status handler before 3pm", secret_santa: "two words 42" });
    expect(outcome.hits).toEqual([]);
  });

  it("does not treat 'Bearer <identifier>' in prose as a token", () => {
    // Built by concatenation so the repository privacy scan does not read these prose fixtures as tokens.
    const scheme = "Bear" + "er";
    for (const line of [`use ${scheme} authentication-header-scheme here`, `${scheme} authorization_header_value`]) {
      expect(redactPlainText(line).hits).toEqual([]);
    }
  });
});

describe("name-based credential rule: real token shapes are still masked in any field", () => {
  const realValues: Array<[string, string]> = [
    ["openai key", fakeOpenAiKey("v")],
    ["github token", fakeGithubToken()],
    ["google api key", fakeGoogleApiKey()],
    ["jwt", fakeJwt()],
    ["long random mixed", randomMixed],
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

  it("masks a PEM block sitting in a key-named field (the pattern rules still run on a non-secret-shaped value)", () => {
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

  it("a password-named field keeps the name-only rule, even for a short plain word", () => {
    expect(redactClientBody({ password: "hunter2x" }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactClientBody({ db_password: "swordfish" }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactClientBody({ password: fakePassword() }).hits).toEqual([{ kind: "password", count: 1 }]);
    expect(redactPlainText("DB_PASSWORD=hunter2x").hits).toEqual([{ kind: "password", count: 1 }]);
  });

  it("still masks a Bearer token, including a long mixed-case base64-ish run with no digit", () => {
    expect(redactPlainText("Authorization: Bearer " + randomMixed).hits).toEqual([{ kind: "token", count: 1 }]);
    expect(redactPlainText("Authorization: Bearer " + "AbCdEfGhIjKlMnOpQrStUv").hits).toEqual([{ kind: "token", count: 1 }]);
  });

  it("masks a mixed-class 8-15 char value under a token-named assignment", () => {
    expect(redactPlainText("API_TOKEN=aB3dE6gH").hits).toEqual([{ kind: "token", count: 1 }]);
  });
});

describe("looksLikeSecretValue", () => {
  it("rejects data-shaped values and accepts secret-shaped ones", () => {
    for (const v of [...STATUS_VALUES, "2026", "v1.2.3", "2026-11-14", "Tue_Nov_14", "camelCaseIdentifier"]) {
      expect(looksLikeSecretValue(v, "")).toBe(false);
    }
    for (const v of [randomMixed, "a1b2c3d4a1b2c3d4", "z".repeat(20), "aB3dE6gH"]) {
      expect(looksLikeSecretValue(v, "")).toBe(true);
    }
  });

  it("non-strict (passwords) accepts any digit-bearing value", () => {
    expect(looksLikeSecretValue("hunter42", "", false)).toBe(true);
    expect(looksLikeSecretValue("hunter42", "", true)).toBe(false);
  });
});
