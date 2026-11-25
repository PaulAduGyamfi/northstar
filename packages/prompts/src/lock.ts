import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Prompts are versioned files that are never edited in place (llm.md, ADR-0013). The lock holds
// the SHA-256 of every committed version; a test fails if one changes, is deleted, or is new
// and unlocked. src/ and dist/ both sit one level below the package root.
export const PROMPTS_DIR = fileURLToPath(new URL("../prompts", import.meta.url));
export const LOCK_FILE = fileURLToPath(new URL("../prompts.lock.json", import.meta.url));

export type Lock = Record<string, string>;

const VERSIONED = /^[a-z0-9-]+\/v[1-9][0-9]*\.md$/;

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Every <route>/vN.md under dir, as "route/vN.md".
export function versionedFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(dir, path).split("\\").join("/");
        if (VERSIONED.test(rel)) found.push(rel);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

export function readLock(path = LOCK_FILE): Lock {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Lock) : {};
}

// Problems in plain sentences; an empty list means the prompts match the lock.
export function checkLock(dir: string, lock: Lock): string[] {
  const problems: string[] = [];
  const files = versionedFiles(dir);
  for (const rel of files) {
    const locked = lock[rel];
    if (locked === undefined) {
      problems.push(
        `${rel} is not in prompts.lock.json. Run pnpm --filter @northstar/prompts lock.`,
      );
    } else if (locked !== hashFile(join(dir, rel))) {
      const next = rel.replace(/v(\d+)\.md$/, (_m, n: string) => `v${Number(n) + 1}.md`);
      problems.push(
        `${rel} changed after it was locked. Write ${next} instead of editing ${rel.split("/")[1]?.replace(".md", "")}.`,
      );
    }
  }
  for (const rel of Object.keys(lock)) {
    if (!files.includes(rel)) {
      problems.push(`${rel} is locked but missing. Versions are never deleted.`);
    }
  }
  return problems;
}

// Adds hashes for new versions. Never rewrites an existing entry, so an edited version still
// fails checkLock after running this.
export function updateLock(dir: string, lock: Lock): Lock {
  const next: Lock = { ...lock };
  for (const rel of versionedFiles(dir)) {
    if (next[rel] === undefined) next[rel] = hashFile(join(dir, rel));
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}
