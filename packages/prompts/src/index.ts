// Public entry of @northstar/prompts: versioned prompt files, locked by hash (ADR-0013).
export { loadPrompt, type Prompt } from "./load.js";
export { checkLock, type Lock, readLock } from "./lock.js";
