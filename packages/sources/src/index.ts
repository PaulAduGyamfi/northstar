// Public entry of @northstar/sources (NS-114): link ingest, ATS clients, JSON-LD and the
// job-extract route, dedupe, and each source's terms status.
export { type AtsTarget, detectAts } from "./ats/detect.js";
export { findDuplicate, type Match, nameKey, SIMILARITY, similarity } from "./dedupe.js";
export { type Extraction, emptyFields, htmlToText } from "./extraction.js";
export * from "./fetch.js";
export { type IngestDeps, type IngestResult, ingestText, ingestUrl } from "./ingest.js";
export {
  checkJobProvenance,
  type DroppedField,
  JOB_EXTRACT_VERSION,
  type JobExtractInput,
  jobExtractRoute,
  PAGE_LIMIT,
  renderPage,
} from "./job-extract-route.js";
export { JobExtract } from "./job-extract-schema.js";
export { findJobPosting, fromJsonLd } from "./jsonld.js";
export { type SourceTerms, type Terms, termsFor } from "./terms.js";
