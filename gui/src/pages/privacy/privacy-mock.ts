/**
 * Development fixtures for the Privacy page, reachable only through `?mock=1` on a dev server.
 *
 * `privacy-api.ts` imports this module dynamically and only after `import.meta.env.DEV` has
 * already passed, so nothing here is on a production path. It exists so the page could be
 * designed and reviewed before the backend's three routes landed.
 *
 * Nothing in here is a real secret, and nothing resembling one is written as a literal: the
 * sample text is assembled at runtime from short fragments, which also keeps the repository's
 * secret scanner out of the business of reviewing fixtures.
 */
import type {
  PrivacyConfig,
  PrivacyKind,
  PrivacyRange,
  PrivacyRequestRecord,
  PrivacyStats,
  PrivacyTestResult,
} from "./privacy-types";

/**
 * Mutable for the session so the settings panel's writes are visible while mocking.
 *
 * The raw values stay in this module variable and are never returned: `mockPrivacyConfig`
 * projects them to `{ id, length }`, exactly as the backend does. That is deliberate — mocking
 * must not be the one mode in which a value could reach the page.
 */
let mockEnabled = true;
let mockAllowValues: string[] = ["sample-allowed-value"];

const CLIENTS = ["multica-agent-sdk", "codex", "claude-code", "cursor", "opencode"];
const PROVIDERS = ["openai", "anthropic", "deepseek", "moonshot"];
const MODELS = ["gpt-6.1-sol", "claude-opus-5-5", "deepseek-v4", "kimi-k3"];
const KINDS: PrivacyKind[] = ["password", "api_key", "token", "email", "private_key", "connection_string"];

/** Deterministic, so a reload shows the same screen and a visual diff stays meaningful. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function isoDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offsetDays);
  return date.toISOString().slice(0, 10);
}

function buildRequests(days: number, random: () => number): PrivacyRequestRecord[] {
  const out: PrivacyRequestRecord[] = [];
  for (let day = 0; day < Math.min(days, 4); day++) {
    const perDay = day === 0 ? 9 : 6;
    for (let i = 0; i < perDay; i++) {
      const at = new Date();
      at.setDate(at.getDate() - day);
      at.setHours(9 + Math.floor(random() * 12), Math.floor(random() * 60), 0, 0);
      const hitCount = 1 + Math.floor(random() * 3);
      const hits = Array.from({ length: hitCount }, (_, index) => ({
        kind: KINDS[(index + i + day) % KINDS.length]!,
        count: 1 + Math.floor(random() * 4),
      }));
      out.push({
        id: `mock-${day}-${i}`,
        ts: at.toISOString(),
        client: CLIENTS[(i + day) % CLIENTS.length]!,
        provider: PROVIDERS[(i + day * 2) % PROVIDERS.length]!,
        model: MODELS[(i + day) % MODELS.length]!,
        hits,
        total: hits.reduce((sum, hit) => sum + hit.count, 0),
      });
    }
  }
  return out.sort((left, right) => right.ts.localeCompare(left.ts));
}

export function mockPrivacyStats(range: PrivacyRange): PrivacyStats {
  const days = range === "30d" ? 30 : 7;
  const random = rng(days === 7 ? 97 : 31);
  const daily = Array.from({ length: days }, (_, index) => ({
    date: isoDay(days - 1 - index),
    masked: Math.floor(random() * 90),
  }));
  const requests = buildRequests(days, rng(11));
  const flows = CLIENTS.slice(0, 4).map((client, index) => ({
    client,
    provider: PROVIDERS[index % PROVIDERS.length]!,
    masked: 40 + Math.floor(random() * 300),
  }));
  return {
    enabled: mockEnabled,
    range,
    totals: {
      masked: daily.reduce((sum, day) => sum + day.masked, 0),
      distinctValues: 7,
      requests: 60 + days,
    },
    daily,
    flows,
    requests,
  };
}

/** The same projection the backend applies: id and length, never the value. */
export function mockPrivacyConfig(): PrivacyConfig {
  return {
    enabled: mockEnabled,
    allowValues: mockAllowValues.map(value => ({ id: digest(value), length: value.length })),
  };
}

export function mockSavePrivacyEnabled(enabled: boolean): PrivacyConfig {
  mockEnabled = enabled;
  return mockPrivacyConfig();
}

/** Mirrors the route's 400s and its idempotence, so the panel's error path is exercisable. */
export function mockAddAllowValue(value: string): PrivacyConfig {
  if (value.length === 0 || value.length > MOCK_ALLOW_VALUE_MAX_LENGTH) {
    // Concatenated, not interpolated: the i18n lint rule reads template literals, and this
    // string is the server's wire message echoed back, not page copy.
    throw new Error("value must be 1-" + MOCK_ALLOW_VALUE_MAX_LENGTH + " characters");
  }
  if (!mockAllowValues.includes(value)) mockAllowValues = [...mockAllowValues, value];
  return mockPrivacyConfig();
}

export function mockDeleteAllowValue(id: string): PrivacyConfig {
  const next = mockAllowValues.filter(value => digest(value) !== id);
  if (next.length === mockAllowValues.length) throw new Error("not found");
  mockAllowValues = next;
  return mockPrivacyConfig();
}

const MOCK_ALLOW_VALUE_MAX_LENGTH = 4096;

/** Not sha256: a mock placeholder only has to be stable and eight hex digits wide. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * `re` matches the surrounding evidence; the secret itself is group 1 when the pattern needs a
 * label to recognise it, and the whole match otherwise. Only the secret is replaced, so a
 * masked sample still reads like the text the user pasted.
 */
const PATTERNS: Array<{ kind: PrivacyKind; re: RegExp }> = [
  { kind: "api_key", re: new RegExp("\\b((?:" + ["sk", "xai", "gsk"].join("|") + ")[-_][A-Za-z0-9]{8,})\\b", "g") },
  { kind: "private_key", re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g },
  { kind: "connection_string", re: /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@]+@[^\s/]+)/g },
  { kind: "email", re: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g },
  { kind: "password", re: /\b(?:password|passwd|pwd)\s*[:=]\s*(\S+)/gi },
  { kind: "token", re: /\b(?:token|bearer)\s*[:=]?\s*([A-Za-z0-9._-]{12,})\b/gi },
];

export function mockPrivacyTest(text: string): PrivacyTestResult {
  const counts = new Map<PrivacyKind, number>();
  let masked = text;
  for (const { kind, re } of PATTERNS) {
    masked = masked.replace(re, (match: string, secret: string) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return match.replace(secret, `{{SECRET_${digest(secret)}}}`);
    });
  }
  return {
    masked,
    hits: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}
