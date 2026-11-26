import { createHash } from "node:crypto";
import { z } from "zod";
import { err, ok, type Result } from "./result.js";

// An application package as the Apply Gateway sends it (APPLY-001, NS-120). Paul approves its
// SHA-256 (ADR-0017), and the gateway recomputes the hash from exactly what it is about to send,
// so an approval of one version never lets another version out.

// The ATSs with a deterministic adapter today (APPLY-002, P1).
// SmartRecruiters since NS-173 (APPLY-002 P2).
export const APPLY_ATS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
export const ApplyAts = z.enum(APPLY_ATS);
export type ApplyAts = z.infer<typeof ApplyAts>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// A file the gateway uploads, named by its content hash so the bytes can be checked at send time.
export const PackageFile = z
  .object({ fileName: z.string().trim().min(1).max(200), sha256: Sha256 })
  .strict();
export type PackageFile = z.infer<typeof PackageFile>;

export const ApplicationPackage = z
  .object({
    packageId: z.uuid(),
    applicationId: z.uuid(),
    ats: ApplyAts,
    // The ATS's own id for the posting: with the ATS it names the requisition (APPLY-009).
    postingId: z.string().trim().min(1).max(200),
    // Checked against the adapter's own hosts by the gateway; https only here.
    applyUrl: z.url({ protocol: /^https$/ }),
    contact: z
      .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email: z.email(),
        phone: z.string().trim().min(1).max(40).nullable(),
      })
      .strict(),
    resume: PackageFile,
    coverLetter: PackageFile.nullable(),
    // The field map: one value per form field the package fills beyond the standard ones, keyed
    // by the form's own field name (`question_123`, `cards[…]`, an Ashby field id).
    fields: z
      .record(
        z.string().min(1).max(200),
        z.union([z.string().max(10_000), z.array(z.string().max(500)).max(50)]),
      )
      .refine((f) => Object.keys(f).length <= 200, { message: "too many fields" }),
  })
  .strict();
export type ApplicationPackage = z.infer<typeof ApplicationPackage>;

export type InvalidPackage = { kind: "InvalidPackage"; fields: string[] };

// Checks a package; the error names the bad fields, never their values.
export function parsePackage(input: unknown): Result<ApplicationPackage, InvalidPackage> {
  const parsed = ApplicationPackage.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  return err({ kind: "InvalidPackage", fields });
}

// The approval subject for a package: one package is one send (ADR-0017 item 6).
export const packageSubject = (pkg: ApplicationPackage): string =>
  `application_package:${pkg.packageId}`;

// JSON with object keys sorted at every level, so the same package always hashes the same.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// SHA-256 (hex) of the package's canonical JSON: what the producer asks Paul to approve and what
// the gateway presents to verifyApproval.
export function packageSha256(pkg: ApplicationPackage): string {
  return createHash("sha256").update(canonicalJson(pkg)).digest("hex");
}

// Why a submission stopped and waits for Paul's hands (APPLY-006, ADR-0003). Codes only: the feed
// and events carry these, never page text.
export const NEEDS_HUMAN_REASONS = [
  // A challenge the gateway never solves.
  "captcha",
  "login",
  "mfa",
  "account",
  // The form no longer matches the package.
  "unmapped_required",
  "form_changed",
  // Submitted, but no confirmation page was recognized.
  "no_confirmation",
  // The browser failed after the claim: it may or may not have gone out.
  "driver_error",
  // A claim from an earlier run never finished (a crash): never retried blindly.
  "outcome_unknown",
  // The application wasn't awaiting approval when the gateway started.
  "status_conflict",
] as const;
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];
