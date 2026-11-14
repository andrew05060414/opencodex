import { describe, expect, test } from "bun:test";
import { formatPace, MIN_ELAPSED_MS, quotaEta, quotaPace, type QuotaBurnInput } from "../../gui/src/provider-workspace/quota-pace";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A 5-hour window that opened `elapsedHours` ago, so it resets `5 - elapsedHours` hours from now. */
function fiveHour(remaining: number | undefined, elapsedHours: number): QuotaBurnInput {
  return { window: "fiveHour", remaining: remaining as number, resetAt: NOW + (5 - elapsedHours) * HOUR };
}

describe("quota pace", () => {
  test("pace is share used minus share of the window elapsed, in points", () => {
    // 2h of 5h elapsed is 40%; 60% used is +20 points against an even split.
    expect(quotaPace(fiveHour(40, 2), NOW)).toBeCloseTo(20, 9);
    // Nothing used yet, 2h elapsed: 40 points behind an even split.
    expect(quotaPace(fiveHour(100, 2), NOW)).toBeCloseTo(-40, 9);
  });

  test("used is clamped to 0–100 so an out-of-range reading cannot invert the pace", () => {
    expect(quotaPace(fiveHour(120, 2), NOW)).toBeCloseTo(-40, 9);
    expect(quotaPace(fiveHour(-5, 2), NOW)).toBeCloseTo(60, 9);
  });
});

describe("quota eta", () => {
  test("runs out at the average rate when that lands before the reset", () => {
    // 2h elapsed, 60% used: rate 30 points/hour, so 100% comes 3h20m after the window opened,
    // which is 1h20m from now and before the 3h reset.
    const eta = quotaEta(fiveHour(40, 2), NOW);
    expect(eta).toEqual({ kind: "runsOut", at: NOW + 80 * 60_000 });
  });

  test("lasts until reset when the average rate would not exhaust the window in time", () => {
    // 2h elapsed, 20% used: exhaustion at 10h after open, far past the 3h reset.
    expect(quotaEta(fiveHour(80, 2), NOW)).toEqual({ kind: "lasts" });
  });

  test("zero usage never runs out", () => {
    expect(quotaEta(fiveHour(100, 2), NOW)).toEqual({ kind: "lasts" });
  });

  test("already at 100% used is exhausted, not a projection", () => {
    expect(quotaEta(fiveHour(0, 2), NOW)).toEqual({ kind: "exhausted" });
    expect(quotaPace(fiveHour(0, 2), NOW)).toBeCloseTo(60, 9);
  });

  test("a weekly window is placed by its 7-day span", () => {
    // 3 of 7 days elapsed, 60% used: exhaustion at open + 5 days = now + 2 days, before the 4-day reset.
    const weekly = { window: "weekly" as const, remaining: 40, resetAt: NOW + 4 * DAY };
    expect(quotaEta(weekly, NOW)).toEqual({ kind: "runsOut", at: NOW + 2 * DAY });
    expect(quotaPace(weekly, NOW)).toBeCloseTo(60 - (3 / 7) * 100, 9);
  });

  test("too little elapsed time gives no projection, but pace still exists", () => {
    const early = fiveHour(90, 0.5);
    expect(quotaEta(early, NOW)).toBeNull();
    // 10% used against 10% elapsed is an even split.
    expect(quotaPace(early, NOW)).toBeCloseTo(0, 9);
    expect(MIN_ELAPSED_MS).toBe(HOUR);
  });
});

describe("quota pace and eta: insufficient data", () => {
  test("no reset time means neither pace nor eta", () => {
    const input: QuotaBurnInput = { window: "fiveHour", remaining: 40 };
    expect(quotaPace(input, NOW)).toBeNull();
    expect(quotaEta(input, NOW)).toBeNull();
  });

  test("a non-finite reset or reading means neither pace nor eta", () => {
    expect(quotaPace({ window: "fiveHour", remaining: 40, resetAt: Number.NaN }, NOW)).toBeNull();
    expect(quotaEta({ window: "fiveHour", remaining: Number.NaN, resetAt: NOW + HOUR }, NOW)).toBeNull();
  });

  test("a window already over is not projected", () => {
    const over = { window: "fiveHour" as const, remaining: 40, resetAt: NOW };
    expect(quotaPace(over, NOW)).toBeNull();
    expect(quotaEta(over, NOW)).toBeNull();
  });

  test("a window that has not opened yet is not projected", () => {
    // Resets in 6 hours, so it only opens in 1 hour: elapsed time is negative.
    const future = { window: "fiveHour" as const, remaining: 40, resetAt: NOW + 6 * HOUR };
    expect(quotaPace(future, NOW)).toBeNull();
    expect(quotaEta(future, NOW)).toBeNull();
  });
});

describe("formatPace", () => {
  test("signed whole points with a real minus sign, and ±0 near zero", () => {
    expect(formatPace(12.4)).toBe("+12");
    expect(formatPace(-7.6)).toBe("−8");
    expect(formatPace(0.3)).toBe("±0");
    expect(formatPace(-0.2)).toBe("±0");
  });
});
