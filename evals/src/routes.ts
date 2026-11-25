import { answerDraftEval } from "./sets/answer-draft.js";
import { jobExtractEval } from "./sets/job-extract.js";
import { mailClassifyEval } from "./sets/mail-classify.js";
import { profileExtractEval } from "./sets/profile-extract.js";
import { resumeTailorEval } from "./sets/resume-tailor.js";
import { storyDraftEval } from "./sets/story-draft.js";
import type { RegisteredEval } from "./types.js";

// Every route's eval set, by route name. `eval --all` (CI) replays each one.
export const registry: Readonly<Record<string, RegisteredEval>> = {
  "answer-draft": answerDraftEval,
  "job-extract": jobExtractEval,
  "mail-classify": mailClassifyEval,
  "profile-extract": profileExtractEval,
  "resume-tailor": resumeTailorEval,
  "story-draft": storyDraftEval,
};
