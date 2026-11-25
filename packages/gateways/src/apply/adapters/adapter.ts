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
  // The ATS's posting id in an apply URL path, or null if the path isn't one of its postings.
  // The requisition key comes from here, so a package can't name another posting than it opens.
  postingIdOf: (path: string) => string | null;
};

// The first capture group of a path pattern, lower-cased (posting UUIDs differ only in case).
export const capture =
  (pattern: RegExp) =>
  (path: string): string | null =>
    pattern.exec(path)?.[1]?.toLowerCase() ?? null;

// Lower-cased page text without tags, for marker checks.
export const pageText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
