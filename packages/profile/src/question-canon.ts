// The question canon moved to packages/domain (NS-249) so the Gate can match form questions too.
// Re-exported here so profile's own imports and its index stay as they were.
export {
  CANONICAL_QUESTIONS,
  type CanonicalQuestion,
  type CanonicalQuestionId,
  FACTUAL_FIELDS,
  type FactualField,
  QUESTION_KINDS,
  type QuestionKind,
} from "@northstar/domain";
