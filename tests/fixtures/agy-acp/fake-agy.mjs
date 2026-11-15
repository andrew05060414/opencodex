// A stand-in for `agy`: `models` prints one model, `acp` speaks just enough ACP for one text turn.
// Every process start and every session it opens is appended to FAKE_AGY_LOG as JSON lines.
import fs from "node:fs";

const log = (event) => {
  if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\n");
};

if (process.argv[2] === "models") {
  process.stdout.write("gemini-3.8-flash  Gemini 3.8 Flash\n");
  process.exit(0);
}

log({ event: "start" });
let sessions = 0;
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const models = { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] };

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || !method) return;
  switch (method) {
    case "initialize":
      return send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } },
        agentInfo: { name: "fake agy", version: "1.5.9" },
      } });
    case "session/new": {
      const sessionId = `${process.pid}-${++sessions}`;
      log({ event: "session/new", sessionId });
      return send({ id, result: { sessionId, models, configOptions: [] } });
    }
    case "session/prompt":
      log({ event: "session/prompt", sessionId: params.sessionId });
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } } });
      return send({ id, result: { stopReason: "end_turn" } });
    case "session/close":
    case "session/cancel":
    case "session/set_model":
      return send({ id, result: {} });
    default:
      return send({ id, error: { code: -32601, message: `fake agy: no ${method}` } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
