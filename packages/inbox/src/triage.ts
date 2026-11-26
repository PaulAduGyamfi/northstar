import type { LlmGateway, Route } from "@northstar/llm";
import { classifyByRules } from "./classify-rules.js";
import type { FullMessage } from "./gmail.js";
import { BODY_LIMIT, type MailClassifyInput } from "./mail-classify-route.js";
import type { MailClassification } from "./mail-schema.js";
import { isAuthenticatedSender } from "./prefilter.js";
import { checkMailProvenance } from "./provenance.js";
import { VERIFICATION_PHRASES } from "./verify/detect.js";
import { extractVerification } from "./verify/extract.js";

// Classifying one job email that is linked to an application (NS-164, INB-003): the same rules
// and route as the backfill (NS-113). Its result feeds mailStatusChange (@northstar/domain),
// which decides the status move. The caller (the mail-link loop, #224) stores it.

export type TriageDeps = {
  gateway: LlmGateway;
  route: Route<MailClassifyInput, MailClassification>;
};

export type ReviewReason = "refused" | "truncated" | "invalid_output" | "ambiguous" | "provenance";

// Which prompt and model answered; never the body or anything quoted from it.
export type TriageStamp = { promptVersion: number; model: string };

export type TriageResult =
  // Verification mail belongs to the Verification Catcher: never classified or sent to the
  // model (INB-012).
  | { kind: "skip"; reason: "verification" }
  | { kind: "classified"; by: "rules"; classification: MailClassification }
  | { kind: "classified"; by: "model"; classification: MailClassification; stamp: TriageStamp }
  // Paul decides: the model couldn't answer, named no employer, or named one not in the email.
  | { kind: "review"; reason: ReviewReason; stamp: TriageStamp };

// A transport error or a HeldBack (switch, breaker, spend cap) from the gateway is thrown, not
// turned into a review: the message isn't decided yet, so the caller retries it later.
export async function classifyLinkedMail(
  deps: TriageDeps,
  mail: FullMessage,
): Promise<TriageResult> {
  // Verification mail from any sender, not only an ATS (the backfill's NS-150 checks are
  // ATS-only): a linked message can come from an employer's own portal or an assessment vendor.
  // A false positive only skips a message, which is safer than a code reaching the model.
  if (isAnyVerificationMail(mail)) return { kind: "skip", reason: "verification" };
  // Rules only for a sender Gmail authenticated: a forged "Thank you for applying" goes to the
  // model, whose answer the provenance check holds to the email's own words. Any authenticated
  // domain passes here, so `by: "rules"` is no proof of the sender: only matchMail's
  // senderVerified may let a status change apply (mailStatusChange).
  const rule = isAuthenticatedSender(mail) ? classifyByRules(mail) : null;
  if (rule !== null) {
    return {
      kind: "classified",
      by: "rules",
      classification: { ...rule, requisition: null, stageSignal: "none" },
    };
  }
  const outcome = await deps.gateway.call(deps.route, {
    from: mail.from,
    subject: mail.subject,
    date: mail.receivedAt.toISOString().slice(0, 10),
    body: mail.body,
  });
  const stamp = { promptVersion: outcome.record.promptVersion, model: outcome.record.modelServed };
  switch (outcome.kind) {
    case "Refused":
      return { kind: "review", reason: "refused", stamp };
    case "Truncated":
      return { kind: "review", reason: "truncated", stamp };
    case "InvalidOutput":
      return { kind: "review", reason: "invalid_output", stamp };
    case "Ok": {
      const o = outcome.output;
      // A linked message that names no employer can't be checked against its application,
      // unless the model says it's about nothing in particular (it changes no status anyway).
      if (o.company === null && o.kind !== "info_other")
        return { kind: "review", reason: "ambiguous", stamp };
      // Code decides (ADR-0004): every name must be in the text the model saw (the body is cut
      // at BODY_LIMIT for it).
      const seen = { from: mail.from, subject: mail.subject, body: mail.body.slice(0, BODY_LIMIT) };
      if (checkMailProvenance(o, seen).length > 0) {
        return { kind: "review", reason: "provenance", stamp };
      }
      return { kind: "classified", by: "model", classification: o, stamp };
    }
  }
}

// A verification subject phrase, or a code beside a code word in the body (VER-003's patterns).
function isAnyVerificationMail(mail: FullMessage): boolean {
  const subject = mail.subject.toLowerCase().replace(/\s+/g, " ");
  if (VERIFICATION_PHRASES.some((phrase) => subject.includes(phrase))) return true;
  return extractVerification(mail.body, null).codes.length > 0;
}
