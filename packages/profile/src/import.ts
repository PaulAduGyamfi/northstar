import { createHash } from "node:crypto";
import type { ImportReport, ProfileCounts, ProfileImportInput } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import type { CallRecord, LlmGateway, LlmOutcome, Route } from "@northstar/llm";
import { isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ProfileExtract } from "./schema.js";
import { type ProvenanceFailure, validateProvenance } from "./validate.js";

export type ImportDeps = {
  gateway: LlmGateway;
  route: Route<{ text: string }, ProfileExtract>;
  // The current resume source's text hash, so an unchanged resume costs no tokens.
  currentHash: () => Promise<string | null>;
  store: (input: ProfileImportInput) => Promise<ImportReport>;
};

export type ImportResult =
  | { kind: "imported"; sourceId: string; counts: ProfileCounts; record: CallRecord }
  | { kind: "unchanged" }
  | { kind: "rejected"; failures: ProvenanceFailure[]; record: CallRecord }
  | {
      kind: "model";
      outcome: Exclude<LlmOutcome<ProfileExtract>["kind"], "Ok">;
      record: CallRecord;
    };

// Resume text → profile graph (CPG-001/002): skip if unchanged, extract with the model, check
// provenance in plain code, then store in one transaction. Anything short of a clean extraction
// writes nothing. LlmTransportError (API down) is thrown to the caller.
export async function importResume(
  deps: ImportDeps,
  input: { candidateId: CandidateId; fileName: string; text: string; reimport?: boolean },
): Promise<ImportResult> {
  return trace.getTracer("@northstar/profile").startActiveSpan("profile.import", async (span) => {
    try {
      const context = span.spanContext();
      const traceId = isSpanContextValid(context) ? context.traceId : null;
      const result = await run(deps, input, traceId);
      span.setAttribute("northstar.profile.outcome", result.kind);
      if (result.kind === "imported") {
        for (const [kind, n] of Object.entries(result.counts)) {
          span.setAttribute(`northstar.profile.count.${kind}`, n);
        }
      }
      if (result.kind === "rejected" || result.kind === "model") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.kind });
      }
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.name : "Error",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run(
  deps: ImportDeps,
  input: { candidateId: CandidateId; fileName: string; text: string; reimport?: boolean },
  traceId: string | null,
): Promise<ImportResult> {
  const textSha256 = createHash("sha256").update(input.text).digest("hex");
  // An unchanged resume costs no tokens, unless Paul asked for a fresh extraction.
  if (!input.reimport && (await deps.currentHash()) === textSha256) return { kind: "unchanged" };

  const outcome = await deps.gateway.call(deps.route, { text: input.text });
  if (outcome.kind !== "Ok")
    return { kind: "model", outcome: outcome.kind, record: outcome.record };

  const provenance = validateProvenance(outcome.output, input.text);
  if (!provenance.ok)
    return { kind: "rejected", failures: provenance.failures, record: outcome.record };

  const report = await deps.store({
    candidateId: input.candidateId,
    fileName: input.fileName,
    textSha256,
    promptVersion: deps.route.prompt.version,
    model: outcome.record.modelServed,
    traceId,
    // Ids, versions and numbers only (no text): what the feed and run inspector need.
    call: { ...outcome.record },
    ...(input.reimport ? { force: true } : {}),
    extract: outcome.output,
  });
  if (report.status === "unchanged") return { kind: "unchanged" };
  return {
    kind: "imported",
    sourceId: report.sourceId,
    counts: report.counts,
    record: outcome.record,
  };
}
