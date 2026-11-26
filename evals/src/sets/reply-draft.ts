import { ReplyDraft, replyDraftRoute, validateReplyDraft } from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the reply-draft route (NS-166, RPL-001). Cases live in
// evals/reply-draft/cases.jsonl: invented emails, recruiters, companies and evidence only (the
// repo is public; real mail stays in evals/**/private/). The fixtures are hand-written until Paul
// records real ones (ADR-0016 item 8), so the baseline is provisional.
export const ReplyInput = z
  .object({
    email: z.string().min(1),
    need: z.enum(["reply", "reply_without_times"]),
    voiceGuide: z.string(),
    evidence: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["story", "atom"]),
          text: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const ReplyExpected = z
  .object({
    // At least one of these ids must be cited; an empty list means the reply makes no claim.
    citesAnyOf: z.array(z.string().min(1)),
    // Whether the email asks something the evidence can't answer.
    followUps: z.boolean(),
    // Words that must not appear in the reply (an injected claim, a commitment, a time).
    absent: z.array(z.string()).optional(),
  })
  .strict();

// Passes only if the draft passes the same check `draftReply` runs and meets the case's
// expectations.
export function gradeReplyDraft(output: unknown, expected: unknown, input: unknown): boolean {
  const d = ReplyDraft.safeParse(output);
  const e = ReplyExpected.safeParse(expected);
  const i = ReplyInput.safeParse(input);
  if (!d.success || !e.success || !i.success) return false;
  const draft = d.data;
  const exp = e.data;

  if (!validateReplyDraft(draft, i.data.evidence, i.data.email).ok) return false;
  const cited = new Set(draft.sentences.flatMap((s) => s.cites.map((c) => c.id)));
  if (exp.citesAnyOf.length === 0 ? cited.size > 0 : !exp.citesAnyOf.some((id) => cited.has(id))) {
    return false;
  }
  if (exp.followUps !== draft.followUps.length > 0) return false;
  const text = draft.sentences
    .map((s) => s.text)
    .join(" ")
    .toLowerCase();
  // Whole words, so "led" isn't found in "settled".
  const has = (w: string) =>
    new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  if (exp.absent?.some(has)) return false;
  return true;
}

export const replyDraftEval = defineEval({
  route: replyDraftRoute(),
  inputSchema: ReplyInput,
  expectedSchema: ReplyExpected,
  grader: gradeReplyDraft,
});
