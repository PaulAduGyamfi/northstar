import { answerDraftEval } from "./sets/answer-draft.js";
import { jobExtractEval } from "./sets/job-extract.js";
import { jobMatchEval } from "./sets/job-match.js";
import { mailClassifyEval } from "./sets/mail-classify.js";
import { positioningThesisEval } from "./sets/positioning-thesis.js";
import { profileExtractEval } from "./sets/profile-extract.js";
import { questionConfirmEval } from "./sets/question-confirm.js";
import { resumeTailorEval } from "./sets/resume-tailor.js";
import { storyDraftEval } from "./sets/story-draft.js";
import { verificationExtractEval } from "./sets/verification-extract.js";
import type { RegisteredEval } from "./types.js";

// Every route's eval set, by route name. `eval --all` (CI) replays each one.
export const registry: Readonly<Record<string, RegisteredEval>> = {
  "answer-draft": answerDraftEval,
  "job-extract": jobExtractEval,
  "job-match": jobMatchEval,
  "mail-classify": mailClassifyEval,
  "positioning-thesis": positioningThesisEval,
  "profile-extract": profileExtractEval,
  "question-confirm": questionConfirmEval,
  "resume-tailor": resumeTailorEval,
  "story-draft": storyDraftEval,
  "verification-extract": verificationExtractEval,
};
