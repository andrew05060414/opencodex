/**
 * Geometry and aggregation for the overview card: which ends of the route to show, and where
 * the strands between them run. Kept out of the component file so the card exports components
 * and nothing else.
 */
import type { PrivacyFlow, PrivacyRange } from "./privacy-types";

export const PRIVACY_RANGES: readonly PrivacyRange[] = ["7d", "30d"];

export interface FlowSlice {
  name: string;
  masked: number;
  /** True for the merged remainder row, which is a translated label rather than an id. */
  rest: boolean;
}

/** Top `limit` by volume; whatever is left becomes one row so the total still adds up. */
export function topSlices(
  rows: readonly { name: string; masked: number }[],
  othersLabel: string,
  limit = 3,
): FlowSlice[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.name) continue;
    totals.set(row.name, (totals.get(row.name) ?? 0) + row.masked);
  }
  const sorted = [...totals].sort((left, right) => right[1] - left[1]);
  const head: FlowSlice[] = sorted.slice(0, limit).map(([name, masked]) => ({ name, masked, rest: false }));
  const tail = sorted.slice(limit);
  if (tail.length > 0) {
    head.push({ name: othersLabel, masked: tail.reduce((sum, [, masked]) => sum + masked, 0), rest: true });
  }
  return head;
}

export function flowSides(flows: readonly PrivacyFlow[], othersLabel: string): {
  clients: FlowSlice[];
  providers: FlowSlice[];
} {
  return {
    clients: topSlices(flows.map(flow => ({ name: flow.client, masked: flow.masked })), othersLabel),
    providers: topSlices(flows.map(flow => ({ name: flow.provider, masked: flow.masked })), othersLabel),
  };
}

/** Vertical position of the nth strand, in the 0–100 box the wires are drawn in. */
export function strandY(index: number, count: number): number {
  return count <= 1 ? 50 : ((index + 0.5) / count) * 100;
}

/**
 * One cubic per strand, pinned to the hub at the centre. `preserveAspectRatio="none"` stretches
 * the box with the card, which is why the strokes are drawn non-scaling.
 */
export function wirePath(y: number, outbound: boolean): string {
  return outbound
    ? "M50 50 C 70 50 70 " + y + " 100 " + y
    : "M0 " + y + " C 30 " + y + " 30 50 50 50";
}
