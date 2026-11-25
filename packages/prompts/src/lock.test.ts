import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrompt } from "./load.js";
import { checkLock, hashFile, PROMPTS_DIR, readLock, updateLock } from "./lock.js";

function promptDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("prompt lock", () => {
  it("passes when every versioned prompt matches its locked hash", () => {
    const dir = promptDir({ "route-a/v1.md": "Say hi.\n" });
    const lock = { "route-a/v1.md": hashFile(join(dir, "route-a/v1.md")) };
    expect(checkLock(dir, lock)).toEqual([]);
  });

  it("fails when a committed version's text changes: a change needs a new version", () => {
    const dir = promptDir({ "route-a/v1.md": "Say hello instead.\n" });
    const lock = { "route-a/v1.md": "0".repeat(64) };
    expect(checkLock(dir, lock)).toEqual([
      "route-a/v1.md changed after it was locked. Write route-a/v2.md instead of editing v1.",
    ]);
  });

  it("fails when a new version isn't locked yet", () => {
    const dir = promptDir({ "route-a/v1.md": "Say hi.\n" });
    expect(checkLock(dir, {})).toEqual([
      "route-a/v1.md is not in prompts.lock.json. Run pnpm --filter @northstar/prompts lock.",
    ]);
  });

  it("fails when a locked version was deleted", () => {
    const dir = promptDir({});
    expect(checkLock(dir, { "route-a/v1.md": "0".repeat(64) })).toEqual([
      "route-a/v1.md is locked but missing. Versions are never deleted.",
    ]);
  });

  it("updateLock adds new versions and never rewrites an existing hash", () => {
    const dir = promptDir({ "route-a/v1.md": "Changed.\n", "route-a/v2.md": "New.\n" });
    const old = { "route-a/v1.md": "0".repeat(64) };
    expect(updateLock(dir, old)).toEqual({
      "route-a/v1.md": "0".repeat(64),
      "route-a/v2.md": hashFile(join(dir, "route-a/v2.md")),
    });
  });

  it("the committed prompts match prompts.lock.json", () => {
    expect(checkLock(PROMPTS_DIR, readLock())).toEqual([]);
  });
});

describe("loadPrompt", () => {
  it("loads a committed prompt by route and version, with its id and version", () => {
    const prompt = loadPrompt("profile-extract", 1);
    expect(prompt.id).toBe("profile-extract");
    expect(prompt.version).toBe(1);
    expect(prompt.text.length).toBeGreaterThan(200);
  });

  it("refuses a version that isn't locked", () => {
    expect(() => loadPrompt("profile-extract", 99)).toThrow(
      "prompt profile-extract/v99.md is not in prompts.lock.json",
    );
  });
});
