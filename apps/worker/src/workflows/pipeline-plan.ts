import { extraKeyProblem, snakeCase } from "./ending.js";

// Plain data and code for the job pipeline workflow (NS-280 slice 2): what each step's activity
// answers, the run's input check and its dead letter's key and codes. No Temporal APIs, so the
// workflow bundle and the activities share it.

// Ids only (NS-242): workflow inputs and activity arguments stay in Temporal's history as plain
// text, so a run names its application and nothing else; every step reads the rest from storage.
export type PipelineInput = { candidateId: string; applicationId: string };

// The tailor step: a new or unchanged tailored resume, or nothing to do (not queued). A refusal
// (no resume import, a job not ready) is no stop: the package step then says what Paul must add.
export type TailorStep =
  | { kind: "tailored"; saved: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "skipped" };

// The form step: the Greenhouse form stored (or unchanged), no Greenhouse link, Greenhouse not
// answering 200 or a form it can't read, a form the store refuses, or nothing to do. Only the
// switch or breaker holding the call back fails the activity (retried, then a dead letter).
export type FormStep = {
  kind: "stored" | "unchanged" | "no_source" | "unreadable" | "refused" | "skipped";
};

// The package step: filed (or found filed by an earlier run), Paul needed (the visible
// `package.needs_human`), nothing to do (not found, or past this step), or stopped with a reason
// code that becomes the run's dead letter.
export type PackageStep =
  | { kind: "filed"; packageSha256: string }
  | { kind: "needs_human" }
  | { kind: "skipped"; reason: "not_found" | "not_queued" }
  | { kind: "stopped"; reasonCode: string };

// Starting the round's submission: started, or already started by an earlier run (its id).
export type StartStep = { kind: "started" | "exists" };

// How a run that didn't fail ended. A refusal or a step that failed all its attempts records a
// dead letter (pipelineKey) and fails the run instead.
export type PipelineResult =
  | { kind: "submission_started" | "submission_exists"; packageSha256: string }
  | { kind: "needs_human" }
  | { kind: "skipped"; reason: "not_found" | "not_queued" };

// The step whose activity failed all its attempts: its dead letter's reason code.
export type PipelineStepName = "tailor" | "form" | "prepare" | "start";
export const stepFailedCode = (step: PipelineStepName): string => `${step}_failed`;

// The reason code of a refusal from preparePackage (`file_refused` or `move_refused`) and its
// error kind, as [a-z0-9_] only (snakeCase), within the 64-character limit.
export function refusalCode(kind: "file_refused" | "move_refused", reason: string): string {
  return `${kind}_${snakeCase(reason) || "unknown"}`.slice(0, 64).replace(/_$/, "");
}

// One dead letter per run, like the submission's (endingKey).
export const pipelineKey = (applicationId: string, runId: string): string =>
  `application:${applicationId}:pipeline:${runId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Why a pipeline input can't run, or null: exactly the two ids, both uuids.
export function pipelineInputProblem(input: object): string | null {
  const extra = extraKeyProblem(input, ["applicationId", "candidateId"]);
  if (extra !== null) return extra;
  const { candidateId, applicationId } = input as Record<string, unknown>;
  if (typeof candidateId !== "string" || !UUID.test(candidateId)) {
    return "candidateId is not a uuid";
  }
  if (typeof applicationId !== "string" || !UUID.test(applicationId)) {
    return "applicationId is not a uuid";
  }
  return null;
}
