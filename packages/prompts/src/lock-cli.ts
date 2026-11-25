import { writeFileSync } from "node:fs";
import { checkLock, LOCK_FILE, PROMPTS_DIR, readLock, updateLock } from "./lock.js";

// `pnpm --filter @northstar/prompts lock`: adds new prompt versions to prompts.lock.json, then
// reports anything still wrong (an edited version stays wrong: write a new version instead).
const lock = updateLock(PROMPTS_DIR, readLock());
writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
const problems = checkLock(PROMPTS_DIR, lock);
for (const p of problems) console.log(p);
console.log(
  problems.length === 0 ? "prompts.lock.json is up to date" : `${problems.length} problem(s)`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
