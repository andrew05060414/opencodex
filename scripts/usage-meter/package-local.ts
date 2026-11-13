/** Generate a machine-local plugin package. Host CLI owns installation and rollback. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const destination = resolve(process.argv[2] ?? join(homedir(), ".agents", "local-marketplaces", "opencodex-meter"));
const plugin = join(destination, "opencodex-meter");
const manifestPath = join(plugin, "plugin.json");
if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).name !== "opencodex-meter") {
  throw new Error("Destination belongs to a different plugin; nothing was changed.");
}
function save(relative: string, value: string | object) {
  const target = resolve(destination, relative);
  if (!target.startsWith(destination + "/") && !target.startsWith(destination + "\\")) throw new Error("Invalid package path");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", "utf8");
}
const presentation = {
  displayName: "OpenCodex Meter", shortDescription: "OpenCodex speed and usage",
  longDescription: "Read local OpenCodex route usage, measured timing, observed cache and estimated costs. Open a live local meter in the Codex browser side panel.",
  developerName: "Local tools", category: "Productivity", capabilities: [],
  defaultPrompt: "Open the OpenCodex meter for this conversation.",
  logo: "./assets/meter.svg", composerIcon: "./assets/meter.svg",
};
save(".agents/plugins/marketplace.json", {
  name: "opencodex-meter-local", interface: { displayName: "OpenCodex local tools" },
  plugins: [{ name: "opencodex-meter", source: { source: "local", path: "./opencodex-meter" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
});
save("opencodex-meter/plugin.json", {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "opencodex-meter", version: "0.1.0", description: presentation.longDescription,
  author: { name: "Local tools" }, extensions: { "com.openai": { interface: presentation, requires_local_executor: true } },
});
save("opencodex-meter/.codex-plugin/plugin.json", {
  name: "opencodex-meter", version: "0.1.0", description: presentation.longDescription,
  interface: presentation, skills: "./skills", mcpServers: "./mcp.json", requires_local_executor: true,
});
save("opencodex-meter/mcp.json", {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { "opencodex-meter": { type: "stdio", command: process.execPath,
    args: [join(import.meta.dir, "mcp.ts")], env: { METER_PORT: "18082", METER_TIMEZONE: "America/New_York" } } },
});
save("opencodex-meter/assets/meter.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#f3f3f3"/><path d="M14 43a21 21 0 1 1 36 0M32 33l11-12M18 32h4m20 0h4M32 14v4" fill="none" stroke="#444" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="33" r="4" fill="#444"/></svg>');
save("opencodex-meter/skills/usage-meter/SKILL.md", `---
name: usage-meter
description: Use when the user asks for OpenCodex generation speed, first-output wait, cache hit rate, routed token usage, estimated cost, or the local meter panel.
---

# OpenCodex meter

Created: 2026-10-25 · Updated: 2026-10-25 · Version: 0.1.0

For a usage question, call the plugin's read_usage tool. Pass the current Codex thread ID as conversation_id when known. Omit it for explicitly machine-wide totals. State whether the result is this chat or all local traffic; never silently substitute another chat.

When asked to open the meter, call open_meter with the current thread ID. Open its returned URL in the current chat's Codex browser panel using open_in_codex. Keep the panel as a deliverable. Read_usage does not start the HTTP panel itself.

Describe generation speed as estimated, using the recorded generation window. A request appears after it finishes; do not claim instantaneous token-by-token measurement. Keep end-to-end speed and first-output waiting separate. Cache may be unknown. Costs are configured-rate/API-equivalent estimates and never proven subscription cash charges. Report unpriced and unmetered coverage with totals.

The plugin is local. It reads the ledger and pricing fields in memory, has no cloud endpoint, and never needs new credentials. Do not change OpenCodex routing, authentication, model selection, prices or startup to make a meter request work. If a tool is absent, say installation needs a new chat; do not recreate the package or restart the user's active Codex session.
`);
console.log(JSON.stringify({ marketplace: destination, name: "opencodex-meter-local", plugin: "opencodex-meter@opencodex-meter-local" }));
