// Career DNA (NS-130): the report's core, plain code with no model, database or network.
export { type Archetype, archetypeOf } from "./archetype.js";
export {
  buildCareerDna,
  type CareerDnaFailure,
  type CareerDnaReport,
  checkCareerDna,
  type ReportLine,
} from "./report.js";
export {
  CAREER_DNA_RUBRIC,
  type DimensionKey,
  type Rubric,
  type RubricDimension,
} from "./rubric.js";
export {
  type Band,
  type CareerDnaAtom,
  type CareerDnaEvidence,
  type CareerDnaStory,
  type Cite,
  type DimensionScore,
  scoreDimensions,
} from "./score.js";
