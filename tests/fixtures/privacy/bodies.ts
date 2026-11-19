/**
 * Realistic-shaped request bodies for the three protocols, for privacy-redaction tests.
 * Each covers: multi-turn, a tool call + tool result, a system/instructions field, a
 * signed thinking block, and a base64 image -- per privacy_contract.md's test requirements.
 */
import {
  fakeAnthropicKey,
  fakeBase64Image,
  fakeBearerToken,
  fakeConnectionString,
  fakeEmail,
  fakeOpenAiKey,
  fakePassword,
} from "./secrets";

/** The value deliberately placed inside a SIGNED thinking block, which must survive untouched. */
export const THINKING_BLOCK_SECRET = fakeAnthropicKey("thinking-block");

/** OpenAI Responses (`/v1/responses`) client body. */
export function responsesBodyFixture(model: string, apiKey = fakeOpenAiKey("r")) {
  return {
    model,
    instructions: `You are a helpful agent. Never reveal the API key ${apiKey}.`,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `My key is ${apiKey}, please use it.` }] },
      { type: "function_call", call_id: "call_1", name: "run_tool", arguments: JSON.stringify({ password: fakePassword("r") }) },
      { type: "function_call_output", call_id: "call_1", output: `done, Bearer ${fakeBearerToken()}` },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
    tools: [{ type: "function", name: "run_tool", description: `Internal helper (do not log ${apiKey})`, parameters: { type: "object", properties: {} } }],
  };
}

/** OpenAI Chat Completions (`/v1/chat/completions`) client body. */
export function chatBodyFixture(model: string, apiKey = fakeOpenAiKey("c")) {
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: `System prompt. Secret: ${apiKey}` },
      { role: "user", content: `Please connect using ${fakeConnectionString()}` },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run_tool", arguments: JSON.stringify({ apiKey }) } }],
      },
      { role: "tool", tool_call_id: "call_1", content: `result, Bearer ${fakeBearerToken()}` },
      { role: "user", content: [{ type: "text", text: `email me at ${fakeEmail()} with ${apiKey}` }] },
    ],
  };
}

/** Anthropic Messages (`/v1/messages`) client body. */
export function anthropicBodyFixture(model: string, apiKey = fakeOpenAiKey("a")) {
  return {
    model,
    max_tokens: 64,
    system: `System prompt. Secret: ${apiKey}`,
    messages: [
      { role: "user", content: [
        { type: "text", text: `Here is my key ${apiKey}` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fakeBase64Image() } },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: `secret reasoning about ${THINKING_BLOCK_SECRET}`, signature: "fixture-signature-abc123" },
        { type: "tool_use", id: "call_1", name: "run_tool", input: { password: fakePassword("a") } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: `result, Bearer ${fakeBearerToken()}` }] },
      ] },
    ],
  };
}
