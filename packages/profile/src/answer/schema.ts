import { z } from "zod";

// The structured output of the answer-draft route (ANS-004, NS-135). Each sentence carries the
// evidence it rests on: the id of a story or atom and a verbatim excerpt of it. The provenance
// check (validate.ts) proves them in plain code before Paul sees the draft.
const Cite = z.object({
  // A story or atom id from the evidence the route was given.
  id: z.string().min(1),
  // An excerpt copied exactly from that item's text.
  quote: z.string().min(1),
});

const Sentence = z.object({
  text: z.string().min(1),
  // At least one: a sentence with nothing of Paul's behind it is invented.
  cites: z.array(Cite).min(1),
});

export const AnswerDraft = z.object({
  sentences: z.array(Sentence).min(1),
  // Questions for Paul when the evidence is too thin. At most two; empty when the answer holds.
  // Shown to Paul as plain text; short, since the question that shaped them is untrusted.
  followUps: z.array(z.string().min(1).max(200)).max(2),
});

export type AnswerDraft = z.infer<typeof AnswerDraft>;
