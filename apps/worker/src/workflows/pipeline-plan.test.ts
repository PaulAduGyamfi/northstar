import { describe, expect, it } from "vitest";
import { pipelineInputProblem, refusalCode, stepFailedCode } from "./pipeline-plan.js";

// The job pipeline's plain decisions (NS-280 slice 2).

const CANDIDATE = "00000000-0000-4000-8000-0000000000c1";
const APP = "00000000-0000-4000-8000-0000000000a1";

describe("pipelineInputProblem", () => {
  it("accepts exactly the two ids, and refuses another field or a malformed id by name", () => {
    expect([
      pipelineInputProblem({ candidateId: CANDIDATE, applicationId: APP }),
      pipelineInputProblem({ candidateId: CANDIDATE, applicationId: APP, jobTitle: "x" }),
      pipelineInputProblem({ candidateId: "x", applicationId: APP }),
      pipelineInputProblem({ candidateId: CANDIDATE, applicationId: 7 }),
    ]).toEqual([
      null,
      "unexpected input field: jobTitle",
      "candidateId is not a uuid",
      "applicationId is not a uuid",
    ]);
  });
});

describe("the pipeline's reason codes", () => {
  it("names a failed step and a refusal in [a-z0-9_] only", () => {
    expect([
      stepFailedCode("form"),
      refusalCode("move_refused", "TransitionNotAllowed"),
      refusalCode("file_refused", "<script> https://x"),
      refusalCode("file_refused", ""),
    ]).toEqual([
      "form_failed",
      "move_refused_transition_not_allowed",
      "file_refused_scripthttpsx",
      "file_refused_unknown",
    ]);
  });
});
