import type { OcxConfig } from "../types";

/**
 * Reply-direction restoration for client-request redaction (opt-in: `privacy.restoreResponses`).
 *
 * The request path swaps secrets for `{{SECRET_xxxxxxxx}}`. Here the placeholders a model echoes
 * back are swapped for the originals, but ONLY for the client that sent them:
 *
 *  - The placeholder -> original map is request-scoped. It hangs off the request's log context in
 *    a WeakMap, so it dies with the request. Nothing is persisted, logged, or counted in stats.
 *  - Restoration runs on the outermost response of each entry point, after the request-log and
 *    usage taps have already seen the masked stream, so those records never hold an original.
 *  - A placeholder with no entry in this request's map stays a placeholder. Another request's
 *    secrets can never appear, because the lookup table is this request's own.
 *  - Any failure while rewriting keeps the masked bytes rather than dropping or guessing.
 *  - Only assistant output text is restored. Tool-call arguments are a separate opt-in
 *    (`restoreToolArguments`) because a restored value there is something a tool can execute.
 *    Reasoning/thinking blocks and every signature or encrypted field are never touched.
 */

export type RestoreWire = "responses" | "chat" | "messages";

const PLACEHOLDER_LITERAL = "{{SECRET_xxxxxxxx}}";
const PLACEHOLDER_PATTERN = /\{\{SECRET_[0-9a-f]{8}\}\}/g;
/** Largest non-stream JSON body we will buffer for rewriting; larger ones pass through masked. */
const MAX_BUFFERED_JSON_BYTES = 32 * 1024 * 1024;

export function isPrivacyRestoreEnabled(config?: OcxConfig | null): boolean {
  return config?.privacy?.restoreResponses === true;
}

export function isRestoreToolArgumentsEnabled(config?: OcxConfig | null): boolean {
  return config?.privacy?.restoreResponses === true && config.privacy.restoreToolArguments === true;
}

interface RestoreEntry {
  wire: RestoreWire;
  map: Map<string, string>;
  ambiguous: Set<string>;
  toolArguments: boolean;
}

const registry = new WeakMap<object, RestoreEntry>();

/**
 * Remember this request's placeholder map under `key` (the request log context, which every
 * entry point and its internal replays share). The first registration fixes `wire`: the entry
 * point that redacted the client's own body owns restoration, an internal replay never re-wraps.
 */
export function registerPrivacyRestore(
  key: object,
  wire: RestoreWire,
  restoreMap: ReadonlyMap<string, string> | undefined,
  config: OcxConfig,
): void {
  if (!isPrivacyRestoreEnabled(config) || !restoreMap || restoreMap.size === 0) return;
  let entry = registry.get(key);
  if (!entry) {
    entry = { wire, map: new Map(), ambiguous: new Set(), toolArguments: isRestoreToolArgumentsEnabled(config) };
    registry.set(key, entry);
  }
  for (const [placeholder, secret] of restoreMap) {
    if (entry.ambiguous.has(placeholder)) continue;
    const known = entry.map.get(placeholder);
    if (known === undefined) entry.map.set(placeholder, secret);
    else if (known !== secret) {
      entry.map.delete(placeholder);
      entry.ambiguous.add(placeholder);
    }
  }
}

const restoredResponses = new WeakSet<Response>();

/** Wrap `response` for the entry point `wire` when this request registered a restore map. */
export function applyPrivacyRestore(key: object, wire: RestoreWire, response: Response): Response {
  const entry = registry.get(key);
  if (!entry || entry.wire !== wire || restoredResponses.has(response)) return response;
  const wrapped = restoreResponse(response, entry.map, entry.toolArguments);
  restoredResponses.add(wrapped);
  return wrapped;
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Replace every known placeholder in `text`. `escapeJson` is for raw JSON-string content. */
export function restoreText(text: string, map: ReadonlyMap<string, string>, escapeJson = false): string {
  if (!text.includes("{{SECRET_")) return text;
  return text.replace(PLACEHOLDER_PATTERN, (placeholder) => {
    const secret = map.get(placeholder);
    if (secret === undefined) return placeholder;
    return escapeJson ? jsonEscaped(secret) : secret;
  });
}

/** Length of the trailing part of `text` that could still grow into a placeholder (0 if none). */
export function partialPlaceholderTail(text: string): number {
  const max = Math.min(text.length, PLACEHOLDER_LITERAL.length - 1);
  for (let len = max; len > 0; len--) {
    if (isPlaceholderPrefix(text.slice(text.length - len))) return len;
  }
  return 0;
}

function isPlaceholderPrefix(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (i < 9 || i >= 17) {
      if (c !== PLACEHOLDER_LITERAL[i]) return false;
    } else if (!/[0-9a-f]/.test(c)) return false;
  }
  return true;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Subtrees whose text is signed, encrypted or reasoning: left byte-for-byte as received. */
const UNTOUCHED_TYPES = new Set(["reasoning", "thinking", "redacted_thinking", "summary_text", "reasoning_text"]);
const TEXT_KEYS = new Set(["text", "content", "output_text"]);

interface WalkState {
  map: ReadonlyMap<string, string>;
  toolArguments: boolean;
  changed: boolean;
}

function restoreInPlace(node: unknown, st: WalkState, parentKey = ""): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === "string") {
        if (TEXT_KEYS.has(parentKey)) { const r = restoreText(item, st.map); if (r !== item) { node[i] = r; st.changed = true; } }
      } else restoreInPlace(item, st, parentKey);
    }
    return;
  }
  if (!isRec(node)) return;
  if (typeof node.type === "string" && UNTOUCHED_TYPES.has(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") {
      if (TEXT_KEYS.has(key)) {
        const r = restoreText(value, st.map);
        if (r !== value) { node[key] = r; st.changed = true; }
      } else if (st.toolArguments && key === "arguments") {
        const r = restoreText(value, st.map, true);
        if (r !== value) { node[key] = r; st.changed = true; }
      }
    } else if (st.toolArguments && key === "input" && node.type === "tool_use") {
      restoreAllStrings(node, "input", st);
    } else if (value && typeof value === "object") {
      restoreInPlace(value, st, key);
    }
  }
}

function restoreAllStrings(holder: Rec, key: string, st: WalkState): void {
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") { const r = restoreText(v, st.map); if (r !== v) st.changed = true; return r; }
    if (Array.isArray(v)) return v.map(visit);
    if (isRec(v)) { for (const k of Object.keys(v)) v[k] = visit(v[k]); return v; }
    return v;
  };
  holder[key] = visit(holder[key]);
}

// ---------------------------------------------------------------------------------------------
// Streaming: a delta channel is one text (or tool-argument) stream inside an SSE response. A
// placeholder can be cut across two deltas, so each channel holds back only the trailing bytes that
// could still become a placeholder and releases everything before them immediately.
// ---------------------------------------------------------------------------------------------

interface DeltaSlot {
  channel: string;
  /** JSON-string content (tool arguments) restores with escaped values. */
  escape: boolean;
  get(): string;
  set(value: string): void;
  /** True when this delta ends the channel (chat finish_reason): nothing may be held back. */
  final: boolean;
}

function deltaSlots(obj: Rec, toolArguments: boolean): DeltaSlot[] {
  const slots: DeltaSlot[] = [];
  const type = obj.type;
  if (type === "response.output_text.delta" && typeof obj.delta === "string") {
    slots.push({ channel: `r:${obj.item_id}:${obj.output_index}:${obj.content_index}`, escape: false, final: false,
      get: () => obj.delta as string, set: (v) => { obj.delta = v; } });
  } else if (toolArguments && type === "response.function_call_arguments.delta" && typeof obj.delta === "string") {
    slots.push({ channel: `ra:${obj.item_id}:${obj.output_index}`, escape: true, final: false,
      get: () => obj.delta as string, set: (v) => { obj.delta = v; } });
  } else if (type === "content_block_delta" && isRec(obj.delta)) {
    const d = obj.delta;
    if (d.type === "text_delta" && typeof d.text === "string") {
      slots.push({ channel: `m:${obj.index}`, escape: false, final: false, get: () => d.text as string, set: (v) => { d.text = v; } });
    } else if (toolArguments && d.type === "input_json_delta" && typeof d.partial_json === "string") {
      slots.push({ channel: `ma:${obj.index}`, escape: true, final: false, get: () => d.partial_json as string, set: (v) => { d.partial_json = v; } });
    }
  } else if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!isRec(choice) || !isRec(choice.delta)) continue;
      const delta = choice.delta;
      const final = choice.finish_reason !== null && choice.finish_reason !== undefined;
      if (typeof delta.content === "string") {
        slots.push({ channel: `c:${choice.index}`, escape: false, final, get: () => delta.content as string, set: (v) => { delta.content = v; } });
      }
      if (toolArguments && Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (isRec(call) && isRec(call.function) && typeof call.function.arguments === "string") {
            const fn = call.function;
            slots.push({ channel: `ca:${choice.index}:${call.index}`, escape: true, final,
              get: () => fn.arguments as string, set: (v) => { fn.arguments = v; } });
          }
        }
      }
    }
  }
  return slots;
}

interface FrameParts {
  other: string[];
  data: string | null;
}

function splitFrame(frame: string): FrameParts {
  const other: string[] = [];
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    else other.push(line);
  }
  return { other, data: data.length ? data.join("\n") : null };
}

function buildFrame(other: string[], payload: string): string {
  const head = other.filter((l) => l.length > 0);
  return `${[...head, `data: ${payload}`].join("\n")}\n\n`;
}

class SseRestorer {
  private pending = new Map<string, { held: string; escape: boolean; flushFrame: (tail: string) => string }>();

  constructor(private readonly map: ReadonlyMap<string, string>, private readonly toolArguments: boolean) {}

  /** Rewrite one SSE frame (without its terminating blank line). Returns text to emit. */
  frame(frame: string): string {
    if (frame.trim().length === 0) return `${frame}\n\n`;
    const raw = `${frame}\n\n`;
    try {
      const parts = splitFrame(frame);
      if (parts.data === null || parts.data === "[DONE]") return this.flushAll() + raw;
      const obj = JSON.parse(parts.data) as unknown;
      if (!isRec(obj)) return this.flushAll() + raw;
      const slots = deltaSlots(obj, this.toolArguments);
      if (slots.length > 0) {
        const template = structuredClone(obj);
        const other = parts.other;
        for (const slot of slots) this.processSlot(slot, template, other);
        return buildFrame(other, JSON.stringify(obj));
      }
      if (obj.type === "ping") return raw;
      // Any other event closes the deltas that came before it: release held tails first.
      const lead = this.flushAll();
      const st: WalkState = { map: this.map, toolArguments: this.toolArguments, changed: false };
      restoreInPlace(obj, st);
      return lead + (st.changed ? buildFrame(parts.other, JSON.stringify(obj)) : raw);
    } catch {
      return raw; // keep the masked bytes
    }
  }

  private processSlot(slot: DeltaSlot, template: Rec, other: string[]): void {
    const prior = this.pending.get(slot.channel);
    const combined = (prior?.held ?? "") + slot.get();
    const restored = restoreText(combined, this.map, slot.escape);
    // `restored` can only end in an unfinished placeholder if the unrestored tail is one.
    const hold = slot.final ? 0 : partialPlaceholderTail(combined);
    const holdRaw = hold > 0 ? combined.slice(combined.length - hold) : "";
    const emit = hold > 0 ? restoreText(combined.slice(0, combined.length - hold), this.map, slot.escape) : restored;
    slot.set(emit);
    if (holdRaw) {
      this.pending.set(slot.channel, {
        held: holdRaw,
        escape: slot.escape,
        flushFrame: (tail) => {
          const clone = structuredClone(template);
          const clonedSlot = deltaSlots(clone, this.toolArguments).find((s) => s.channel === slot.channel);
          if (!clonedSlot) return "";
          clonedSlot.set(tail);
          return buildFrame(other, JSON.stringify(clone));
        },
      });
    } else this.pending.delete(slot.channel);
  }

  /** Emit every held tail (it never completed into a placeholder, so it goes out as received). */
  flushAll(): string {
    if (this.pending.size === 0) return "";
    let out = "";
    for (const p of this.pending.values()) out += p.flushFrame(restoreText(p.held, this.map, p.escape));
    this.pending.clear();
    return out;
  }
}

function sseRestoreStream(body: ReadableStream<Uint8Array>, map: ReadonlyMap<string, string>, toolArguments: boolean): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const restorer = new SseRestorer(map, toolArguments);
  let buffer = "";
  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buffer);
      if (!m) break;
      out += restorer.frame(buffer.slice(0, m.index));
      buffer = buffer.slice(m.index + m[0].length);
    }
    if (final) {
      if (buffer.trim().length > 0) out += restorer.frame(buffer);
      buffer = "";
      out += restorer.flushAll();
    }
    return out;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const tail = drain(true);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const out = drain(false);
        if (out) { controller.enqueue(encoder.encode(out)); return; }
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function restoreResponse(response: Response, map: ReadonlyMap<string, string>, toolArguments: boolean): Response {
  if (!response.body || response.status >= 400 || response.headers.has("content-encoding")) return response;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (type.includes("text/event-stream")) {
    return new Response(sseRestoreStream(response.body, map, toolArguments), init);
  }
  if (type.includes("json")) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BUFFERED_JSON_BYTES) return response;
    return new Response(restoreJsonBody(response, map, toolArguments), init);
  }
  return response;
}

function restoreJsonBody(response: Response, map: ReadonlyMap<string, string>, toolArguments: boolean): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = "";
      try {
        text = await response.text();
        if (text.length > MAX_BUFFERED_JSON_BYTES) throw new Error("body too large");
        const parsed = JSON.parse(text) as unknown;
        const st: WalkState = { map, toolArguments, changed: false };
        restoreInPlace(parsed, st);
        if (st.changed) text = JSON.stringify(parsed);
      } catch {
        // keep `text` exactly as received
      }
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
