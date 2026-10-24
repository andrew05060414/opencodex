/** Native Claude user settings shared by the CLI and Desktop Code. Routing stays untouched. */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { assertNotRealClaudeConfigUnderTest } from "../lib/test-home-guard";
import { claudeConfigDir } from "./gateway-cache";

function readDocument(path: string): { raw: string | null; data: Record<string, unknown> } {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Claude settings must be a regular file.");
    const raw = readFileSync(path, "utf8");
    const data: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Claude settings must be an object.");
    return { raw, data: data as Record<string, unknown> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: null, data: {} };
    throw new Error("Cannot read valid Claude user settings; no changes were made.", { cause: error });
  }
}

export function readClaudeWorkflowSettings(configDir = claudeConfigDir()) {
  const path = join(configDir, "settings.json");
  try {
    const { data } = readDocument(path);
    return {
      ultracode: data.ultracode === true,
      workflowsDisabled: data.disableWorkflows === true || process.env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1",
      workflowSettingsPath: path,
    };
  } catch {
    return { ultracode: false, workflowsDisabled: true, workflowSettingsPath: path,
      workflowSettingsError: "Cannot read valid Claude user settings." };
  }
}

export function setClaudeWorkflowSettings(ultracode: boolean, configDir = claudeConfigDir()) {
  assertNotRealClaudeConfigUnderTest(configDir);
  const path = join(configDir, "settings.json");
  const before = readDocument(path);
  if (ultracode && (before.data.disableWorkflows === true || process.env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1")) {
    throw new Error("Workflows are disabled in Claude settings or the environment. Resolve that setting first.");
  }
  if (before.data.ultracode === ultracode) return readClaudeWorkflowSettings(configDir);
  mkdirSync(configDir, { recursive: true });
  atomicWriteFileNoFollow(path, JSON.stringify({ ...before.data, ultracode }, null, 2) + "\n", undefined, {
    validateBeforeRename: () => {
      if (readDocument(path).raw !== before.raw) throw new Error("Claude settings changed; reload and retry.");
    },
  });
  return readClaudeWorkflowSettings(configDir);
}
