import type { ApplicationPackage, ApplyAts } from "@northstar/domain";

// A deterministic ATS adapter (APPLY-002): which hosts it may open, how Paul's contact block maps
// onto that ATS's standard fields, where the files go, and how its confirmation page looks.
// Field detection is the driver's job; mapping and checking are plain code here.
export type AtsAdapter = {
  ats: ApplyAts;
  // The only hosts an apply URL may point at for this ATS.
  hosts: readonly string[];
  standardFields: (contact: ApplicationPackage["contact"]) => Record<string, string>;
  resumeField: string;
  // null: this ATS has no cover letter upload.
  coverLetterField: string | null;
  isConfirmation: (page: { url: string; html: string }) => boolean;
};

// Lower-cased page text without tags, for marker checks.
export const pageText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
