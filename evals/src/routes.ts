import { profileExtractEval } from "./sets/profile-extract.js";
import type { RegisteredEval } from "./types.js";

// Every route's eval set, by route name. `eval --all` (CI) replays each one.
export const registry: Readonly<Record<string, RegisteredEval>> = {
  "profile-extract": profileExtractEval,
};
