import { z } from "zod";

// The structured output of the profile-extract route (CPG-001/002). Dates keep the precision
// the resume gives: "YYYY-MM", or "YYYY" when it states a year only, or null when it states
// nothing. Never a guessed month. Nothing is optional, so the model has to say "null".
const Month = z
  .string()
  .regex(/^[0-9]{4}(-(0[1-9]|1[0-2]))?$/)
  .nullable();
const HttpUrl = z.string().regex(/^https?:\/\/\S+$/);

export const ProfileExtract = z.object({
  roles: z.array(
    z.object({
      key: z.string().regex(/^r[0-9]+$/),
      employer: z.string().min(1),
      title: z.string().min(1),
      startMonth: Month,
      endMonth: Month,
      // The resume says this role is ongoing ("Present", "Current"). Separate from endMonth, so
      // an unknown end date is never shown as "present".
      current: z.boolean(),
    }),
  ),
  education: z.array(
    z.object({
      school: z.string().min(1),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      startMonth: Month,
      endMonth: Month,
    }),
  ),
  atoms: z.array(
    z.object({
      roleKey: z
        .string()
        .regex(/^r[0-9]+$/)
        .nullable(),
      what: z.string().min(1),
      how: z.array(z.string().min(1)),
      impact: z.string().nullable(),
      scope: z.string().nullable(),
      startMonth: Month,
      endMonth: Month,
      sourceQuote: z.string().min(1),
      evidenceLink: HttpUrl.nullable(),
    }),
  ),
  skills: z.array(z.string().min(1)),
  certifications: z.array(
    z.object({
      name: z.string().min(1),
      issuer: z.string().nullable(),
      issuedMonth: Month,
    }),
  ),
  links: z.array(z.object({ label: z.string().min(1), url: HttpUrl })),
});

export type ProfileExtract = z.infer<typeof ProfileExtract>;
