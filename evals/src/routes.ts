import { mailClassifyEval } from "./sets/mail-classify.js";
import { profileExtractEval } from "./sets/profile-extract.js";
import { storyDraftEval } from "./sets/story-draft.js";
import type { RegisteredEval } from "./types.js";

// Every route's eval set, by route name. `eval --all` (CI) replays each one.
export const registry: Readonly<Record<string, RegisteredEval>> = {
  "mail-classify": mailClassifyEval,
  "profile-extract": profileExtractEval,
  "story-draft": storyDraftEval,
};
