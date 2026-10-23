import type { AdapterEvent, OcxMessagePhase, OcxUsage } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { decodeServerSentEvents } from "../lib/sse-decoder";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolKey(tool: Record<string, unknown>): string | undefined {
  if (typeof tool.type !== "string" || !tool.type) return undefined;
  const name = typeof tool.name === "string" ? tool.name : "";
  return tool.type + "\0" + name;
}

/**
 * Zed's OpenAI Responses schema accepts message and call items, not Codex's private
 * additional_tools wrapper. Drop every wrapper. Promote only wrappers at or after the
 * replayed prefix: earlier ones are history, not the current turn's tool catalog.
 * A non-array tools field is left untouched so a malformed catalog is not replaced
 * by a partial promotion.
 */
export function liftZedAdditionalTools(providerRequest: Record<string, unknown>, replayPrefixLength: number): void {
  if (!Array.isArray(providerRequest.input)) return;
  if (providerRequest.tools !== undefined && !Array.isArray(providerRequest.tools)) return;

  const currentTurnStart = Number.isFinite(replayPrefixLength)
    ? Math.min(providerRequest.input.length, Math.max(0, Math.trunc(replayPrefixLength)))
    : 0;
  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const [index, item] of providerRequest.input.entries()) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      changed = true;
      if (index >= currentTurnStart) promoted.push(...item.tools);
      continue;
    }
    input.push(item);
  }
  if (!changed) return;

  const seen = new Set<string>();
  const tools: unknown[] = [];
  const existing = Array.isArray(providerRequest.tools) ? providerRequest.tools : [];
  for (const tool of [...existing, ...promoted]) {
    if (!isRecord(tool)) {
      tools.push(tool);
      continue;
    }
    const key = toolKey(tool);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    tools.push(tool);
  }
  providerRequest.input = input;
  providerRequest.tools = tools;
}

interface CallState {
  key: string;
  callId: string;
  name: string;
  args: string;
  pendingFull?: string;
  started: boolean;
  ended: boolean;
}

function phaseOf(item: Record<string, unknown>): OcxMessagePhase | undefined {
  return item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
}

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "output_text" && typeof part.text === "string")
    .map(part => String(part.text))
    .join("");
}

function usageFromResponse(response: unknown): OcxUsage | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  const usage = response.usage;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof inputDetails?.cached_tokens === "number"
      ? { cachedInputTokens: inputDetails.cached_tokens, cacheReadInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number"
      ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
      : {}),
  };
}

function failureMessage(payload: Record<string, unknown>): string {
  const source = isRecord(payload.response) ? payload.response : payload;
  const err = source.error ?? payload.error;
  if (typeof err === "string" && err) return err;
  if (isRecord(err) && typeof err.message === "string" && err.message) return err.message;
  if (typeof source.message === "string" && source.message) return source.message;
  return "Zed OpenAI request failed";
}

function incompleteReason(payload: Record<string, unknown>): string {
  const source = isRecord(payload.response) ? payload.response : payload;
  const details = isRecord(source.incomplete_details) ? source.incomplete_details : undefined;
  if (typeof details?.reason === "string" && details.reason) return details.reason;
  return failureMessage(payload);
}

/**
 * Translate Zed's OpenAI Responses SSE into adapter events.
 *
 * The shared Responses passthrough parser only keeps message text, because its other caller
 * is compaction. Using it here drops function and custom calls, and Codex then stores the
 * first sentence as final_answer and ends the turn. A later synthetic response.completed
 * with empty output (Zed's stream-ended frame) must not wipe usage taken from the real
 * completion, and completed output must not repeat text or calls that already streamed.
 */
export async function* translateZedOpenAiStream(
  body: ReadableStream<Uint8Array> | null,
  budget: TranslatorBudget,
): AsyncGenerator<AdapterEvent> {
  if (!body) {
    yield { type: "error", message: "Zed OpenAI response had no body" };
    return;
  }

  const calls = new Map<string, CallState>();
  const phases = new Map<string, OcxMessagePhase>();
  const textByItem = new Map<string, string>();
  let unscopedText = "";
  let sawThinking = false;
  let sawRawReasoning = false;
  let usage: OcxUsage | undefined;
  let terminal = false;

  function* closeOpenCallsExcept(keep: CallState): Generator<AdapterEvent> {
    for (const other of calls.values()) {
      if (other !== keep && other.started && !other.ended) {
        other.ended = true;
        yield { type: "tool_call_end" };
      }
    }
  }

  function* startIfNeeded(state: CallState): Generator<AdapterEvent> {
    if (state.started || state.ended || !state.name) return;
    yield* closeOpenCallsExcept(state);
    state.started = true;
    yield { type: "tool_call_start", id: state.callId, name: state.name };
    if (state.args) yield { type: "tool_call_delta", arguments: state.args };
  }

  function* appendArgs(state: CallState, fragment: string): Generator<AdapterEvent> {
    if (!fragment || state.ended) return;
    if (!state.started) {
      if (!state.name) {
        state.args += fragment;
        return;
      }
      yield* startIfNeeded(state);
    }
    state.args += fragment;
    yield { type: "tool_call_delta", arguments: fragment };
  }

  function rememberFull(state: CallState, full: unknown): void {
    if (typeof full === "string" && full.length > 0) state.pendingFull = full;
  }

  function* finishCall(state: CallState): Generator<AdapterEvent> {
    if (state.ended) return;
    const full = state.pendingFull;
    if (typeof full === "string" && full.length > state.args.length && full.startsWith(state.args)) {
      yield* appendArgs(state, full.slice(state.args.length));
    }
    yield* startIfNeeded(state);
    if (!state.started) return;
    state.ended = true;
    yield { type: "tool_call_end" };
  }

  function ensureCall(key: string, callId: string, name: string): CallState {
    let state = calls.get(key);
    if (!state) {
      state = { key, callId, name, args: "", started: false, ended: false };
      calls.set(key, state);
      return state;
    }
    if (callId) state.callId = callId;
    if (name) state.name = name;
    return state;
  }

  function noteText(itemId: string | undefined, text: string): void {
    if (itemId) textByItem.set(itemId, text);
    else unscopedText = text;
  }

  function* emitNewText(text: string, phase?: OcxMessagePhase, itemId?: string): Generator<AdapterEvent> {
    if (!text) return;
    // A completed response repeats every message. Deltas from different messages must not
    // be concatenated before that comparison, or the earlier message matches neither the
    // whole string nor its prefix and is appended a second time.
    let previous = itemId !== undefined && textByItem.has(itemId) ? textByItem.get(itemId) ?? "" : "";
    if (!previous && unscopedText) {
      if (text === unscopedText || text.startsWith(unscopedText)) {
        previous = unscopedText;
        unscopedText = "";
      } else if (unscopedText.startsWith(text)) {
        unscopedText = unscopedText.slice(text.length);
        noteText(itemId, text);
        return;
      }
    }
    if (!previous) {
      noteText(itemId, text);
      yield { type: "text_delta", text, ...(phase ? { phase } : {}) };
      return;
    }
    if (text === previous || previous.endsWith(text)) {
      noteText(itemId, previous);
      return;
    }
    if (text.startsWith(previous)) {
      const tail = text.slice(previous.length);
      noteText(itemId, text);
      if (tail) yield { type: "text_delta", text: tail, ...(phase ? { phase } : {}) };
      return;
    }
    noteText(itemId, previous + text);
    yield { type: "text_delta", text, ...(phase ? { phase } : {}) };
  }

  function* observeToolItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return;
    const key = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
    if (!key) return;
    const callId = typeof item.call_id === "string" ? item.call_id : key;
    const name = typeof item.name === "string" ? item.name : "";
    const state = ensureCall(key, callId, name);
    rememberFull(state, item.type === "custom_tool_call" ? item.input : item.arguments);
    if (done) yield* finishCall(state);
    else yield* startIfNeeded(state);
  }

  function* emitReasoningItem(item: Record<string, unknown>): Generator<AdapterEvent> {
    if (!sawThinking && Array.isArray(item.summary)) {
      const text = item.summary
        .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawThinking = true;
        yield { type: "thinking_delta", thinking: text };
      }
    }
    if (!sawRawReasoning && Array.isArray(item.content)) {
      const text = item.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawRawReasoning = true;
        yield { type: "reasoning_raw_delta", text };
      }
    }
  }

  function* consumeItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type === "message") {
      const phase = phaseOf(item);
      if (typeof item.id === "string" && phase) phases.set(item.id, phase);
      if (done) yield* emitNewText(messageText(item), phase, typeof item.id === "string" ? item.id : undefined);
      return;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      yield* observeToolItem(item, done);
      return;
    }
    if (done && item.type === "reasoning") yield* emitReasoningItem(item);
  }

  function* onPayload(payload: Record<string, unknown>): Generator<AdapterEvent> {
    if (payload.type === "error" || payload.type === "response.failed") {
      terminal = true;
      yield { type: "error", message: failureMessage(payload) };
      return;
    }
    if (payload.type === "response.incomplete") {
      terminal = true;
      for (const state of calls.values()) yield* finishCall(state);
      const response = isRecord(payload.response) ? payload.response : undefined;
      const nextUsage = usageFromResponse(response) ?? usage;
      if (nextUsage) usage = nextUsage;
      yield { type: "incomplete", reason: incompleteReason(payload), ...(usage ? { usage } : {}) };
      return;
    }
    if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
      if (isRecord(payload.item)) yield* consumeItem(payload.item, payload.type === "response.output_item.done");
      return;
    }
    if (payload.type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta) {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
      const phase = itemId ? phases.get(itemId) : undefined;
      if (itemId) textByItem.set(itemId, (textByItem.get(itemId) ?? "") + payload.delta);
      else unscopedText += payload.delta;
      yield { type: "text_delta", text: payload.delta, ...(phase ? { phase } : {}) };
      return;
    }
    if (payload.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawThinking = true;
      yield { type: "thinking_delta", thinking: payload.delta };
      return;
    }
    if (payload.type === "response.reasoning_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawRawReasoning = true;
      yield { type: "reasoning_raw_delta", text: payload.delta };
      return;
    }
    if (
      (payload.type === "response.function_call_arguments.delta" || payload.type === "response.custom_tool_call_input.delta")
      && typeof payload.delta === "string"
    ) {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      yield* appendArgs(ensureCall(key, key, ""), payload.delta);
      return;
    }
    if (payload.type === "response.function_call_arguments.done" || payload.type === "response.custom_tool_call_input.done") {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      const state = ensureCall(key, key, "");
      rememberFull(state, payload.type === "response.custom_tool_call_input.done" ? payload.input : payload.arguments);
      yield* finishCall(state);
      return;
    }
    if (payload.type === "response.completed") {
      const response = isRecord(payload.response) ? payload.response : undefined;
      if (response && Array.isArray(response.output)) {
        for (const item of response.output) {
          if (isRecord(item)) yield* consumeItem(item, true);
        }
      }
      const nextUsage = usageFromResponse(response);
      if (nextUsage) usage = nextUsage;
    }
  }

  for await (const event of decodeServerSentEvents(body, { translatorBudget: budget })) {
    let payload: unknown;
    try { payload = JSON.parse(event.data); } catch { continue; }
    if (!isRecord(payload)) continue;
    yield* onPayload(payload);
    if (terminal) return;
  }

  for (const state of calls.values()) yield* finishCall(state);
  yield { type: "done", ...(usage ? { usage } : {}) };
}

