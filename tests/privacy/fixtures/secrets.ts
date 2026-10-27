/**
 * Fake secret values for privacy-redaction tests, built at runtime by concatenation rather
 * than written as literals -- per privacy_contract.md's "提交规则": the gitleaks pre-commit
 * hook scans literal-looking secrets, and these must never trip it or, worse, be real.
 */

export function fakeOpenAiKey(seed = "a"): string {
  return "sk-" + seed.repeat(20) + "-" + "b".repeat(20);
}

export function fakeAnthropicKey(seed = "a"): string {
  return "sk-ant-" + seed.repeat(20) + "-" + "c".repeat(16);
}

export function fakeAwsAccessKeyId(): string {
  // The canonical AWS documentation example id -- not a live credential.
  return ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
}

export function fakeGithubToken(): string {
  return "ghp_" + "1".repeat(20) + "2".repeat(16);
}

export function fakeJwt(): string {
  const seg = (ch: string, n: number) => ch.repeat(n);
  return `eyJ${seg("a", 12)}.${seg("b", 12)}.${seg("c", 12)}`;
}

export function fakeBearerToken(): string {
  return "my" + "secret" + "bearer" + "token" + "1234567890abcdef";
}

export function fakePassword(seed = "x"): string {
  return "Sup3r" + seed + "Secret" + "Pass".repeat(3) + "99";
}

export function fakeConnectionStringPassword(): string {
  return "S3cret" + "Conn" + "Pass123";
}

export function fakeConnectionString(): string {
  return `postgres://admin:${fakeConnectionStringPassword()}@db.internal:5432/main`;
}

export function fakeGoogleApiKey(): string {
  return "AIza" + "B".repeat(35);
}

export function fakePrivateKeyBody(): string {
  return "M" + "I".repeat(30) + "B" + "a".repeat(30);
}

export function fakePrivateKeyBlock(): string {
  return `-----BEGIN RSA PRIVATE KEY-----\n${fakePrivateKeyBody()}\n-----END RSA PRIVATE KEY-----`;
}

export function fakeDotEnvSecretLine(): string {
  return `MY_APP_SECRET=${"z".repeat(24)}`;
}

export function fakeEmail(): string {
  return "andrew" + "@" + "example.com";
}

export function fakeBase64Image(): string {
  // A real (tiny, 1x1 transparent) PNG: OpenCodex's own image validation decodes this and
  // would replace an undecodable blob with an omission placeholder, which would make a
  // byte-identical round-trip assertion fail for a reason that has nothing to do with
  // redaction. Real-looking input keeps the test about redaction only.
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGAWjR9awAAAABJRU5ErkJggg==";
}
