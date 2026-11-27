// The question matcher moved to packages/domain (NS-249) so the Gate can match form questions too.
// Re-exported here so profile's own imports and its index stay as they were.
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
} from "@northstar/domain";
