// Public entry of @northstar/domain: the application state machine, the Approval Gate's
// policies, circuit breakers (NS-126), domain events and ids, and since NS-125 the health
// model and feed lines.
// Pure code with no I/O; packages/db stores what this package defines.
export * from "./application-status.js";
export * from "./apply-package.js";
export * from "./approval.js";
export * from "./breaker.js";
export * from "./company-name.js";
export * from "./consent.js";
export * from "./domain-event.js";
export * from "./feed.js";
export * from "./follow-up.js";
export * from "./growth.js";
export * from "./growth-progress.js";
export * from "./health.js";
export * from "./ids.js";
export * from "./interview-prep.js";
export * from "./mail-status.js";
export * from "./mail-tag.js";
export * from "./origin.js";
export * from "./pipeline-metrics.js";
// The question canon and its matcher (NS-249, moved from packages/profile): plain code the Gate
// uses too. Named exports only, so the matcher's internals stay internal.
export {
  CANONICAL_QUESTIONS,
  type CanonicalQuestion,
  type CanonicalQuestionId,
  FACTUAL_FIELDS,
  type FactualField,
  QUESTION_KINDS,
  type QuestionKind,
} from "./question-canon.js";
export {
  AMBIGUITY_MARGIN,
  classifyQuestion,
  FACTUAL_THRESHOLD,
  isNegatedQuestion,
  MATCH_THRESHOLD,
  matchQuestion,
  type QuestionClassification,
  type QuestionMatch,
  questionConcepts,
  rankCanonical,
} from "./question-match.js";
// One rule for how a reused banked answer counts (NS-249 slice 3): producer and Gate share it.
export {
  isDisguisedLabel,
  isExactWording,
  labelReuse,
  REUSE_HIGH_CONFIDENCE,
  type ReuseSource,
  reuseStrength,
  weakerReuse,
} from "./question-reuse.js";
export * from "./recruiter-grade.js";
export * from "./recruiter-learn.js";
export * from "./reply-draft.js";
export * from "./reply-need.js";
export * from "./result.js";
export * from "./stats.js";
export * from "./tenant-account.js";
export { normalize } from "./text-normalize.js";
