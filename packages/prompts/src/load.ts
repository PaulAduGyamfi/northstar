import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile, PROMPTS_DIR, readLock } from "./lock.js";

export type Prompt = { id: string; version: number; text: string };

// Loads a committed prompt version. Refuses one that isn't locked, or whose text no longer
// matches its locked hash, so a route can't run an edited prompt under an old version number.
export function loadPrompt(id: string, version: number): Prompt {
  const rel = `${id}/v${version}.md`;
  const locked = readLock()[rel];
  if (locked === undefined) throw new Error(`prompt ${rel} is not in prompts.lock.json`);
  const path = join(PROMPTS_DIR, rel);
  if (hashFile(path) !== locked) throw new Error(`prompt ${rel} doesn't match its locked hash`);
  return { id, version, text: readFileSync(path, "utf8") };
}
