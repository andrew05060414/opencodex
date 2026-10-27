/**
 * Day grouping and the two clock formats the request list uses. Separated from the list
 * component so "which day is this row on?" can be tested without a DOM, and so the list file
 * exports components only.
 */
import type { Locale, TFn } from "../../i18n/shared";
import type { PrivacyRequestRecord } from "./privacy-types";

/** Local-calendar day key; grouping on the ISO prefix would move rows across midnight. */
export function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface PrivacyDayGroup {
  key: string;
  at: Date | null;
  rows: PrivacyRequestRecord[];
}

export function groupRequestsByDay(requests: readonly PrivacyRequestRecord[]): PrivacyDayGroup[] {
  const groups = new Map<string, PrivacyDayGroup>();
  for (const request of requests) {
    const at = new Date(request.ts);
    const valid = !Number.isNaN(at.getTime());
    const key = valid ? dayKey(at) : "";
    let group = groups.get(key);
    if (!group) {
      group = { key, at: valid ? at : null, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(request);
  }
  return [...groups.values()];
}

export function dayHeading(
  key: string,
  at: Date | null,
  locale: Locale,
  t: TFn,
  now = new Date(),
): string {
  if (!at) return t("privacy.group.unknownDay");
  if (key === dayKey(now)) return t("privacy.group.today");
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday)) return t("privacy.group.yesterday");
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short" }).format(at);
}

export function formatTimeOfDay(ts: string, locale: Locale): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

export function formatDayLabel(date: string, locale: Locale): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(parsed);
}
