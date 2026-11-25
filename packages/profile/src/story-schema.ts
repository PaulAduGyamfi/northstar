import { COMPETENCIES } from "@northstar/db";
import { z } from "zod";

// The structured output of the story-draft route (CPG-003, NS-111). Each STAR part carries the
// verbatim excerpts of Paul's answers it rests on; the provenance check (story-validate.ts)
// proves them in plain code before Paul sees the draft.
const Part = z.object({
  text: z.string().min(1),
  // Excerpts copied exactly from Paul's answers. At least one: a part with nothing of his behind
  // it is invented.
  quotes: z.array(z.string().min(1)).min(1),
});

export const StoryDraft = z.object({
  title: z.string().min(1),
  situation: Part,
  task: Part,
  action: Part,
  result: Part,
  // The experience atoms the story rests on: the interview's atom.
  atomIds: z.array(z.string().min(1)).min(1),
  // One to three distinct tags; the same tag twice would count as two of the three.
  competencies: z
    .array(z.enum(COMPETENCIES))
    .min(1)
    .max(3)
    .refine((tags) => new Set(tags).size === tags.length, "competencies must be distinct"),
  // Questions for Paul when a part is too thin to tell. At most two; empty when the story holds.
  followUps: z.array(z.string().min(1)).max(2),
});

export type StoryDraft = z.infer<typeof StoryDraft>;

// The tag list lives with the database CHECK that enforces it; re-exported for routes and evals.
export { COMPETENCIES };

export const STAR_PARTS = ["situation", "task", "action", "result"] as const;
export type StarPart = (typeof STAR_PARTS)[number];
