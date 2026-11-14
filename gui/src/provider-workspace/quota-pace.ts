/**
 * Pace and burn-rate projection for one quota window, shown under each 5-hour and weekly bar of
 * the account table. Pure, so the arithmetic is testable without rendering.
 *
 * Data limit: the dashboard only receives the current reading of a window (remaining share and
 * reset time). The server keeps Codex quota history, but it is not sent to the GUI, so there is
 * no time series to fit. The projection therefore assumes the average rate since the window
 * opened stays constant: used / elapsed. That over-projects when the burn was front-loaded and
 * under-projects when the window was idle at the start. A least-squares fit over history points
 * (Magpie's quotaEta) becomes possible once the series reaches the GUI.
 *
 * Window start is `resetAt - span`, with the span assumed from the window kind (5 hours or 7 days),
 * the same labels the account table already maps to these windows.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const WINDOW_SPAN_MS = { fiveHour: 5 * HOUR_MS, weekly: 7 * DAY_MS } as const;
export type QuotaWindowKind = keyof typeof WINDOW_SPAN_MS;

/**
 * Below this much elapsed time a single request dominates the average, so no projection is made.
 * Pace is still shown, since it is a plain difference and not a projection.
 */
export const MIN_ELAPSED_MS = HOUR_MS;

export interface QuotaBurnInput {
  window: QuotaWindowKind;
  /** Remaining share, 0–100, as the account table shows it. */
  remaining: number;
  /** Epoch milliseconds when this window resets. Without it the window cannot be placed in time. */
  resetAt?: number;
}

export type QuotaEta =
  /** At the average rate, the window reaches 100% used at `at` (epoch ms), before it resets. */
  | { kind: "runsOut"; at: number }
  /** At the average rate, the window is still short of 100% used when it resets. */
  | { kind: "lasts" }
  /** Already at 100% used; nothing left to project. */
  | { kind: "exhausted" };

interface WindowFrame {
  /** Share used so far, 0–100. */
  used: number;
  /** Time since the window opened, in milliseconds (> 0). */
  elapsed: number;
  span: number;
  start: number;
  resetAt: number;
}

/** The window's position in time, or `null` when it is not usable: no reset, not started, or already over. */
function windowFrame(input: QuotaBurnInput, now: number): WindowFrame | null {
  const { resetAt, remaining } = input;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  if (now >= resetAt) return null;
  const span = WINDOW_SPAN_MS[input.window];
  const start = resetAt - span;
  const elapsed = now - start;
  if (elapsed <= 0) return null;
  const used = Math.max(0, Math.min(100, 100 - remaining));
  return { used, elapsed, span, start, resetAt };
}

/**
 * Pace in percentage points: share used minus share of the window that has elapsed.
 * `+12` means 12 points more than an even split so far; `-8` means 8 points less.
 * `null` when the window cannot be placed in time.
 */
export function quotaPace(input: QuotaBurnInput, now: number = Date.now()): number | null {
  const frame = windowFrame(input, now);
  if (!frame) return null;
  return frame.used - (frame.elapsed / frame.span) * 100;
}

/**
 * When the window would run out at the average rate since it opened.
 *
 * Average rate r = used / elapsed. It reaches 100% at `start + 100 * elapsed / used`. If that is
 * before the reset, the window runs out; otherwise it lasts until reset. Zero usage never runs out.
 * `null` when there is too little elapsed time to project from (see MIN_ELAPSED_MS).
 */
export function quotaEta(input: QuotaBurnInput, now: number = Date.now()): QuotaEta | null {
  const frame = windowFrame(input, now);
  if (!frame || frame.elapsed < MIN_ELAPSED_MS) return null;
  if (frame.used >= 100) return { kind: "exhausted" };
  if (frame.used <= 0) return { kind: "lasts" };
  const at = frame.start + (100 * frame.elapsed) / frame.used;
  return at >= frame.resetAt ? { kind: "lasts" } : { kind: "runsOut", at };
}

/** Pace as a signed whole number of points: "+12", "−8", or "±0". The minus sign is U+2212. */
export function formatPace(pace: number): string {
  const rounded = Math.round(pace);
  if (rounded === 0) return "±0";
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}
