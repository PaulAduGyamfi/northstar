import { z } from "zod";

// INB-003's message types. The same list as @northstar/db's MAIL_KINDS; a test in packages/funnel
// proves the two match, since this package doesn't depend on the database.
export const MAIL_KINDS = [
  "confirmation",
  "rejection",
  "assessment",
  "interview_request",
  "scheduling",
  "recruiter_inbound",
  "follow_up_needed",
  "offer",
  "info_other",
] as const;

// The furthest funnel stage the message shows (13-search-diagnostics, stages C to E and offer).
export const STAGE_SIGNALS = ["none", "screen", "technical", "onsite", "offer"] as const;

// What the mail-classify route returns for one job email. Company, role and requisition must
// appear verbatim in the message (checkMailProvenance), or the message goes to Paul's review.
export const MailClassification = z
  .object({
    kind: z.enum(MAIL_KINDS),
    company: z.string().nullable(),
    role: z.string().nullable(),
    requisition: z.string().nullable(),
    stageSignal: z.enum(STAGE_SIGNALS),
  })
  .strict();

export type MailClassification = z.infer<typeof MailClassification>;
