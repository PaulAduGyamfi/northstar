import { createHash } from "node:crypto";
import {
  assignTag,
  type Db,
  type PackageInputs,
  readPackageInputs,
  readPackageRounds,
  recordPackageNeedsHuman,
  transitionApplication,
} from "@northstar/db";
import {
  ApplicationId,
  type ApplicationStatus,
  type CandidateId,
  type ContactDetails,
  generateMailTag,
  isTaggableAddress,
  taggedAddress,
} from "@northstar/domain";
import { type AssemblyInput, assemblePackage, type BankEntry } from "./assemble.js";
import { filePackage } from "./file.js";
import { formQuestions } from "./form.js";

// The caller that turns one queued application into a filed package (NS-227 slice 6,
// APPLY-001/006, ADR-0023): plain code, no model or network. It reads every input from storage,
// assembles, and either files with the Gate and moves the application to awaiting_approval, or
// records why Paul is needed. It never submits: only the Apply Gateway does, after the Gate.

export type PrepareResult =
  | { kind: "refused"; reason: "not_found" | "not_queued" }
  | { kind: "needs_human"; reasons: Record<string, number>; recorded: boolean }
  | {
      kind: "filed";
      packageId: string;
      requestId: string;
      // A policy Paul set approved it as it was filed (APPLY-004); otherwise it waits in his queue.
      autoApproved: boolean;
      // A rerun after a crash found the request already decided: Paul's own approval or rejection.
      decision: "approved" | "rejected" | null;
      replayed: boolean;
    }
  // The Gate refused the request, or a status move was refused: the error's kind only. The caller
  // (the worker, #230) turns these into a dead letter, so they are never silently dropped.
  | { kind: "file_refused" | "move_refused"; reason: string };

// The package's hash covers its own id, so the id can't come from a hash that contains it: the
// content is hashed once under this fixed stand-in (a version 4 UUID), and the id derived from that.
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The package's id from its application, its round and its content: a version 8 (custom) UUID from
// the hash, so the same inputs in the same round give the same id and a rerun replays the first
// Gate request. A new round (after Paul rejected a package) gets a new id even for the same content.
export function packageIdFor(applicationId: string, round: number, contentSha256: string): string {
  const hex = sha256(`${applicationId}:${round}:${contentSha256}`).slice(0, 32).split("");
  hex[12] = "8";
  // RFC 9562 variant: the top two bits of this digit are 10.
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// What the resume is called on the form: Paul's name in letters, digits and hyphens only.
export function resumeFileName(contact: { firstName: string; lastName: string }): string {
  const part = (s: string) =>
    s
      .normalize("NFKD")
      // Accents split off by NFKD go first, so "Renée" reads "Renee", not "Rene-e".
      .replace(/\p{M}/gu, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // Each part is cut, never the "-resume.pdf" ending.
      .slice(0, 80)
      .replace(/-+$/, "");
  const first = part(contact.firstName);
  const last = part(contact.lastName);
  return first && last ? `${first}-${last}-resume.pdf` : "resume.pdf";
}

// Statuses the caller works from: queued, or package_ready left by a run that crashed after filing.
const READY_TO_PREPARE: readonly string[] = ["queued", "package_ready"];

export async function preparePackage(
  db: Db,
  input: { candidateId: CandidateId; applicationId: string },
): Promise<PrepareResult> {
  const inputs = await readPackageInputs(db, input.candidateId, input.applicationId);
  if (!inputs) return { kind: "refused", reason: "not_found" };
  if (!READY_TO_PREPARE.includes(inputs.application.status))
    return { kind: "refused", reason: "not_queued" };

  const reasons: Record<string, number> = {};
  const add = (code: string, n = 1) => {
    reasons[code] = (reasons[code] ?? 0) + n;
  };

  // Only Greenhouse has stored forms (slice 1), so the package goes through its Greenhouse source.
  const source = inputs.sources.find((s) => s.ats === "greenhouse" && Boolean(s.postingId));
  const form = inputs.form?.ats === "greenhouse" ? inputs.form : null;
  const contact = inputs.contact;
  const pdf = inputs.resume?.pdfSha256 ?? null;
  if (!source) add("no_ats_source");
  if (!form) add("no_form");
  if (!contact) add("no_contact");
  if (!pdf) add("no_resume_file");
  const fields = form ? formQuestions(form.questions) : null;
  // assemblePackage doesn't see these two: they must stop the package here (slice 4).
  if (fields?.phoneRequired && contact && contact.phone === null) add("no_phone");
  if (fields && fields.unsupported.length > 0) add("file_upload", fields.unsupported.length);

  // The form gets the application's tagged address (VER-007), so its mail links by tag first. The
  // tag is assigned once a package can be built and kept for good, so a rerun builds the same
  // package; a stored address with its own `+` part goes out as it is (tags never stack).
  const buildable = Boolean(source?.postingId && form && contact && pdf && fields);
  const formContact =
    buildable && contact
      ? await withTag(
          db,
          { candidateId: input.candidateId, applicationId: inputs.application.id },
          contact,
        )
      : contact;

  const build = (packageId: string): AssemblyInput | null =>
    source?.postingId && form && formContact && pdf && fields
      ? {
          packageId,
          applicationId: inputs.application.id,
          ats: "greenhouse",
          postingId: source.postingId,
          applyUrl: source.url,
          company: inputs.companyName,
          contact: formContact,
          resume: { fileName: resumeFileName(formContact), sha256: pdf },
          coverLetter: null,
          coverLetterRequired: fields.coverLetterRequired,
          questions: fields.questions,
          settings: inputs.settings,
          bank: bankByCanonical(inputs),
          fit: inputs.fit,
          formSeenBefore: inputs.formSeenBefore,
        }
      : null;

  const draftInput = build(PLACEHOLDER_ID);
  const draft = draftInput ? assemblePackage(draftInput) : null;
  if (draft && !draft.ok) {
    if (draft.error.kind === "NeedsHuman") for (const u of draft.error.unanswered) add(u.reason);
    else add("invalid_package", Math.max(1, draft.error.fields.length));
  }
  const needsYou = async (): Promise<PrepareResult> => {
    const recorded = await recordPackageNeedsHuman(db, {
      candidateId: input.candidateId,
      applicationId: inputs.application.id,
      reasons,
      basis: basisOf(inputs, reasons),
    });
    if (!recorded.ok) throw new Error("package needs-human event refused");
    return { kind: "needs_human", reasons, recorded: recorded.value.recorded };
  };
  if (!draft?.ok) {
    // Only an unbuilt input can leave no draft, and each one added its reason above.
    if (Object.keys(reasons).length === 0) add("invalid_package");
    return needsYou();
  }
  if (Object.keys(reasons).length > 0) return needsYou();

  // Each round starts with its queued -> package_ready move, made before filing and keyed by the
  // package id, so a run that crashed after it resumes with that round's id.
  const rounds = await readPackageRounds(db, input.candidateId, inputs.application.id);
  const resuming = inputs.application.status === "package_ready";
  if (resuming && rounds.lastPackageId === null) return { kind: "refused", reason: "not_queued" };
  const packageId = packageIdFor(
    inputs.application.id,
    resuming ? rounds.rounds - 1 : rounds.rounds,
    draft.value.sha256,
  );
  // A crashed round whose inputs changed since: its package id is fixed (package_ready only moves
  // on), so a second package is never filed beside the first. Paul withdraws or restores inputs.
  if (resuming && packageId !== rounds.lastPackageId) {
    add("inputs_changed");
    return needsYou();
  }
  const move = (from: ApplicationStatus, to: ApplicationStatus) =>
    transitionApplication(db, {
      candidateId: input.candidateId,
      applicationId: ApplicationId.parse(inputs.application.id),
      from,
      to,
      actor: "system",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: `application:${inputs.application.id}:package:${packageId}:${to}`,
    });
  if (!resuming) {
    const opened = await move("queued", "package_ready");
    if (!opened.ok) return { kind: "move_refused", reason: opened.error.kind };
  }

  // The same package under its own id: the content is unchanged, so this can't fail.
  const finalInput = build(packageId);
  const assembled = finalInput ? assemblePackage(finalInput) : null;
  if (!assembled?.ok) throw new Error("package changed between its two builds");
  const filed = await filePackage(db, input.candidateId, assembled.value);
  if (!filed.ok) return { kind: "file_refused", reason: filed.error.kind };

  const moved = await move("package_ready", "awaiting_approval");
  if (!moved.ok) return { kind: "move_refused", reason: moved.error.kind };
  const decision = filed.value.decision;
  return {
    kind: "filed",
    packageId,
    requestId: filed.value.requestId,
    // Only a policy's approval made as this request was filed; a replay's decision is reported
    // as it is (Paul may have approved or rejected it while the run was down).
    autoApproved:
      !filed.value.replayed && decision?.decidedBy === "policy" && decision.decision === "approved",
    decision: decision?.decision ?? null,
    replayed: filed.value.replayed,
  };
}

// Paul's contact details with the application's own tag on his address.
async function withTag(
  db: Db,
  input: { candidateId: CandidateId; applicationId: string },
  contact: ContactDetails,
): Promise<ContactDetails> {
  if (!isTaggableAddress(contact.email)) return contact;
  const { tag } = await assignTag(db, {
    candidateId: input.candidateId,
    target: { applicationId: input.applicationId },
    newTag: generateMailTag,
  });
  return { ...contact, email: taggedAddress(contact.email, tag) };
}

// The newest approved answer per canonical question, as assemblePackage takes it.
function bankByCanonical(inputs: PackageInputs): Map<string, BankEntry> {
  return new Map(
    inputs.bank.map((b) => [
      b.canonicalId,
      { shortText: b.shortText, longText: b.longText, answerId: b.answerId, version: b.version },
    ]),
  );
}

// What the package was assembled from, hashed: the same inputs and reasons record the needs-you
// line once. Only the hash leaves this function (it becomes part of an idempotency key).
function basisOf(inputs: PackageInputs, reasons: Record<string, number>): string {
  return sha256(
    JSON.stringify({
      application: inputs.application.id,
      form: inputs.form?.sha256 ?? null,
      resume: inputs.resume?.pdfSha256 ?? null,
      sources: inputs.sources.map((s) => [s.ats, s.postingId]),
      contact: inputs.contact,
      settings: inputs.settings.map((s) => [s.field, s.qualifier, s.value]),
      bank: inputs.bank.map((b) => [b.canonicalId, b.version]),
      reasons: Object.entries(reasons).sort(([a], [b]) => (a < b ? -1 : 1)),
    }),
  );
}
