import { antigravityRateLimit } from "../adapters/antigravity-refusal";
import { ANTIGRAVITY_QUOTA_EXHAUSTED_PREFIX } from "../adapters/google-errors";

/**
 * What one request may do after an Antigravity refusal. Google can answer with 429s that say
 * nothing about the account, so a refusal never walks the pool: quota exhaustion is the only
 * account-level 429, a capacity 429 is model-wide, and a reasonless one earns at most one sibling.
 */
const QUOTA_COOLDOWN_MIN_SECONDS = 5 * 60;
const QUOTA_COOLDOWN_MAX_SECONDS = 24 * 60 * 60;
const QUOTA_COOLDOWN_DEFAULT_SECONDS = 15 * 60;
const UNREASONED_LADDER_SECONDS = [5, 15, 30] as const;
const UNREASONED_LADDER_MEMORY_MS = 10 * 60_000;
const UNREASONED_COOLDOWN_CEILING_SECONDS = 5 * 60;
const MAX_UNREASONED_HOPS_PER_REQUEST = 1;
const MAX_403_REFUSALS_PER_REQUEST = 2;
export const ANTIGRAVITY_VALIDATION_COOLDOWN_MS = 15 * 60_000;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_DISTINCT_ACCOUNTS = 3;
const BREAKER_OPEN_MS = 45_000;
const STATE_CAP = 512;

interface RequestState { unreasonedHops: number; counted: Set<string>; refusals403: number }
const requestStates = new WeakMap<object, RequestState>();
function stateOf(request: object): RequestState {
  let state = requestStates.get(request);
  if (!state) requestStates.set(request, state = { unreasonedHops: 0, counted: new Set(), refusals403: 0 });
  return state;
}

const ladder = new Map<string, { count: number; at: number }>();
const reasonless = new Map<string, Map<string, number>>();
const breakerOpenUntil = new Map<string, number>();
const modelKey = (modelId: string) => modelId.trim().toLowerCase();
function bounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= STATE_CAP && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}

/** Same model, three different accounts, 60 seconds: stop touching the pool for a short while. */
function noteReasonless(modelId: string, accountId: string, now: number): void {
  const key = modelKey(modelId);
  const seen = reasonless.get(key) ?? new Map<string, number>();
  for (const [id, at] of seen) if (now - at > BREAKER_WINDOW_MS) seen.delete(id);
  seen.set(accountId, now);
  bounded(reasonless, key, seen);
  if (seen.size >= BREAKER_DISTINCT_ACCOUNTS) bounded(breakerOpenUntil, key, now + BREAKER_OPEN_MS);
}

/** Seconds a new request for this model must wait before the pool is touched again, or 0. */
export function antigravityPoolBreakerSeconds(modelId: string, now = Date.now()): number {
  const until = breakerOpenUntil.get(modelKey(modelId));
  return until !== undefined && until > now ? Math.ceil((until - now) / 1000) : 0;
}

/** `declined`: the 429 is the account-independent kind; the caller records it as a declined payload. */
export type Antigravity429Plan = { readonly rotate: false; readonly declined?: true } | { readonly rotate: true; readonly retryAfter: string };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Decide whether this 429 may move the request to a sibling and how long the refused account rests.
 * `response` carries the Google adapter's reading of the body; with none (a preflight error object)
 * only the quota wording in `message` can justify leaving the account.
 */
export function planAntigravity429Rotation(
  request: object, response: Response | undefined, accountId: string, modelId: string,
  message?: string, now = Date.now(),
): Antigravity429Plan {
  const limit = response ? antigravityRateLimit(response) : undefined;
  const quotaByMessage = !limit && message?.startsWith(`${ANTIGRAVITY_QUOTA_EXHAUSTED_PREFIX}`) === true;
  if (limit?.kind === "quota" || quotaByMessage) {
    return { rotate: true,
      retryAfter: String(clamp(limit?.waitSeconds ?? QUOTA_COOLDOWN_DEFAULT_SECONDS, QUOTA_COOLDOWN_MIN_SECONDS, QUOTA_COOLDOWN_MAX_SECONDS)) };
  }
  if (limit?.kind === "capacity") return { rotate: false };
  // Same answer from every account: no rotation, no cooldown, and not evidence for the breaker.
  if (limit?.kind === "declined") return { rotate: false, declined: true };
  if (!limit || !limit.reasoned) noteReasonless(modelId, accountId, now);
  const state = stateOf(request);
  if (state.unreasonedHops >= MAX_UNREASONED_HOPS_PER_REQUEST) return { rotate: false };
  state.unreasonedHops += 1;
  // One rung per (account, model) per request: repeating the question must not climb the ladder.
  const key = `${accountId}\0${modelKey(modelId)}`;
  const previous = ladder.get(key);
  let count = previous && now - previous.at <= UNREASONED_LADDER_MEMORY_MS ? previous.count : 0;
  if (!state.counted.has(key)) { count += 1; state.counted.add(key); bounded(ladder, key, { count, at: now }); }
  const rung = UNREASONED_LADDER_SECONDS[Math.min(Math.max(count, 1), UNREASONED_LADDER_SECONDS.length) - 1]!;
  const stated = limit?.retryDelaySeconds;
  return { rotate: true,
    retryAfter: String(stated !== undefined ? clamp(stated, rung, UNREASONED_COOLDOWN_CEILING_SECONDS) : rung) };
}

/** Attribute a `declined` plan in the usage log: Google rejected the content, so resending is futile. */
export function withDeclinedCause(plan: Antigravity429Plan, logCtx: { causeHint?: "payload-rejected" | string }): Antigravity429Plan {
  if (!plan.rotate && plan.declined) logCtx.causeHint = "payload-rejected";
  return plan;
}

/** A second refused account in one request points at the client or region, not at one account. */
export function antigravity403MayRotate(request: object): boolean {
  const state = stateOf(request);
  state.refusals403 += 1;
  return state.refusals403 < MAX_403_REFUSALS_PER_REQUEST;
}

/** Test seam: forget every process-local rate-limit memory. */
export function resetAntigravityRateLimitPolicy(): void {
  ladder.clear(); reasonless.clear(); breakerOpenUntil.clear();
}
