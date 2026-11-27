import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldUseBuildSlot, wrapWithBuildSlot } from "../../scripts/lib/build-slot";

describe("scripts/lib/build-slot", () => {
  test("delegates only on win32 non-CI when build-slot.js exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-bs-"));
    try {
      const slot = join(dir, "build-slot.js");
      writeFileSync(slot, "");

      expect(shouldUseBuildSlot({ BUILD_SLOT_PATH: slot }, "win32")).toBe(true);
      expect(shouldUseBuildSlot({ BUILD_SLOT_PATH: slot, CI: "true" }, "win32")).toBe(false);
      expect(shouldUseBuildSlot({ BUILD_SLOT_PATH: slot }, "linux")).toBe(false);
      expect(shouldUseBuildSlot({ BUILD_SLOT_PATH: join(dir, "missing.js") }, "win32")).toBe(false);

      const wrapped = wrapWithBuildSlot("compile", "bun", ["x", "tsc", "--noEmit"], { BUILD_SLOT_PATH: slot }, "win32");
      expect(wrapped.delegated).toBe(true);
      expect(wrapped.command).toBe("node");
      expect(wrapped.args).toEqual([slot, "--queue", "compile", "--", "bun", "x", "tsc", "--noEmit"]);

      const passthrough = wrapWithBuildSlot("compile", "bun", ["x", "tsc", "--noEmit"], { BUILD_SLOT_PATH: slot, CI: "1" }, "win32");
      expect(passthrough.delegated).toBe(false);
      expect(passthrough.command).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
