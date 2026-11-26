import { z } from "zod";

// The structured output of the reply-draft route (RPL-001, NS-166). Like an answer draft, every
// sentence that says something about Paul cites his stories or atoms with a verbatim excerpt. A
// reply also needs a greeting and a thank-you, so a sentence may cite nothing: that is framing,
// and validate.ts holds framing to plain words (no numbers, times or outside names).
const Cite = z.object({
  // A story or atom id from the evidence the route was given.
  id: z.string().min(1),
  // An excerpt copied exactly from that item's text.
  quote: z.string().min(1),
});

const Sentence = z.object({
  text: z.string().min(1),
  // Empty: framing. Otherwise a claim, checked like an answer-draft sentence.
  cites: z.array(Cite),
});

export const ReplyDraft = z.object({
  // A short email: a few framing sentences and a few claims.
  sentences: z.array(Sentence).min(1).max(12),
  // Questions for Paul when the email asks something his evidence doesn't answer. Plain text,
  // short, since the email that shaped them is untrusted.
  followUps: z.array(z.string().min(1).max(200)).max(2),
});

export type ReplyDraft = z.infer<typeof ReplyDraft>;
