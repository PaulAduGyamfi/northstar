import type { RegisteredEval } from "./types.js";

// Every route's eval set, by route name. Empty until the first agent ticket adds a route,
// its prompt and evals/<route>/ (spec NS-106: out of scope here).
export const registry: Readonly<Record<string, RegisteredEval>> = {};
