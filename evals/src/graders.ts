import { isDeepStrictEqual } from "node:util";

// A grader decides whether one output is right for one case. Plain code, no model (an
// LLM-as-judge grader is out of scope for NS-106).
// The case input is passed too, for graders that check output against it (provenance).
export type Grader = (output: unknown, expected: unknown, input?: unknown) => boolean;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

// Every field named in `expected` must equal the output's field (deep equality). Fields the
// case doesn't mention (a confidence score) are ignored.
export const fieldsSubset: Grader = (output, expected) => {
  const out = asRecord(output);
  return Object.entries(asRecord(expected)).every(([key, value]) =>
    isDeepStrictEqual(out[key], value),
  );
};

// One named field must match exactly.
export const exactField =
  (field: string): Grader =>
  (output, expected) =>
    isDeepStrictEqual(asRecord(output)[field], asRecord(expected)[field]);

// Passes any output that reached the grader: the gateway already checked it against the
// route's schema. For routes where "valid JSON of the right shape" is the whole test.
export const schemaOnly: Grader = () => true;
