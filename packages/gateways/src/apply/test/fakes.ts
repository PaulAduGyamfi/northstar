import { randomUUID } from "node:crypto";
import type { ProofView, SubmissionView } from "@northstar/db";
import {
  type ApplicationPackage,
  type ApplicationStatus,
  type CallDecision,
  type CallOutcome,
  err,
  type NeedsHumanReason,
  nextStatus,
  ok,
  packageSha256,
  packageSubject,
} from "@northstar/domain";
import type { FormDriver, PageState } from "../driver.js";
import type { ApplyPorts } from "../ports.js";
import { COVER, RESUME, sha } from "./fixtures.js";

// In-memory stand-ins for the database write paths (their own tests run on PGlite in
// packages/db) and a scripted browser. They keep the behavior the gateway relies on: one claim
// per idempotency key, one per requisition, and the state machine's legal moves.

export type FakeWorld = {
  ports: ApplyPorts;
  status: () => ApplicationStatus;
  submissions: SubmissionView[];
  proofs: ProofView[];
  driverCalls: { open: number; submit: number; close: number };
  // What the gateway told the breakers: dependency, outcome and the probe's token.
  reports: { dependency: string; outcome: CallOutcome; probeToken: string | null }[];
  // The switches and breakers it asked about, in order.
  checks: string[];
  // How each move to submitted said it went out (INB-007).
  submittedVia: string[];
  // A decision id for this package; with a refusal, the Gate refuses it that way.
  approve: (pkg: ApplicationPackage, refusal?: "Rejected" | "Undone" | "UndoWindowOpen") => string;
};

export function fakeWorld(script: {
  open?: () => Promise<PageState>;
  submit?: () => Promise<PageState>;
  close?: () => Promise<void>;
  initialStatus?: ApplicationStatus;
  // Whether a repeated in-progress claim is past CLAIM_STALE_AFTER_MS (the database decides).
  claimStale?: boolean;
  // Kill switches that are off (every other one is on).
  switchesOff?: string[];
  // The breaker's answer (allowed, no probe, by default); a throw stands for Postgres down.
  breaker?: (dependency: string) => Promise<CallDecision>;
  // Who the Gate says decided: Paul ("user", the default) or an auto-approve policy.
  decidedBy?: "user" | "policy";
}): FakeWorld {
  const submittedVia: string[] = [];
  let status: ApplicationStatus = script.initialStatus ?? "awaiting_approval";
  type GateRefusal = "Rejected" | "Undone" | "UndoWindowOpen";
  const approvals = new Map<string, { subject: string; hash: string; refusal?: GateRefusal }>();
  const submissions: SubmissionView[] = [];
  const proofs: ProofView[] = [];
  const keys = new Map<string, SubmissionView>();
  const requisitions = new Set<string>();
  const driverCalls = { open: 0, submit: 0, close: 0 };
  const reports: FakeWorld["reports"] = [];
  const checks: string[] = [];
  const files = new Map([
    [sha(RESUME), RESUME],
    [sha(COVER), COVER],
  ]);

  const driver: FormDriver = {
    open: async () => {
      driverCalls.open++;
      if (!script.open) throw new Error("no page scripted");
      return script.open();
    },
    fillAndSubmit: async () => {
      driverCalls.submit++;
      if (!script.submit) throw new Error("no submit scripted");
      return script.submit();
    },
    close: async () => {
      driverCalls.close++;
      if (script.close) await script.close();
    },
  };

  const finish = (id: string, to: "submitted" | "needs_human", reason: NeedsHumanReason | null) => {
    const s = submissions.find((x) => x.submissionId === id);
    if (s === undefined || s.status !== "in_progress") return null;
    s.status = to;
    s.reason = reason;
    s.finishedAt = new Date();
    return s;
  };

  const ports: ApplyPorts = {
    verifyApproval: async (input) => {
      const a = approvals.get(input.decisionId);
      if (!a) return err({ kind: "NotFound" as const });
      if (a.subject !== input.subject) return err({ kind: "SubjectMismatch" as const });
      if (a.hash !== input.contentSha256) return err({ kind: "ContentChanged" as const });
      if (a.refusal === "UndoWindowOpen") {
        return err({ kind: "UndoWindowOpen" as const, effectiveAt: new Date(0) });
      }
      if (a.refusal) return err({ kind: a.refusal });
      return ok({
        decisionId: input.decisionId,
        requestId: randomUUID(),
        decidedBy: script.decidedBy ?? "user",
        effectiveAt: new Date(0),
      });
    },
    claimSubmission: async (input) => {
      const key = `application:${input.applicationId}:submit`;
      const existing = keys.get(key);
      if (existing) {
        const proof = proofs.find((p) => p.submissionId === existing.submissionId) ?? null;
        const stale = existing.status === "in_progress" && (script.claimStale ?? true);
        return ok({ claimed: false as const, submission: { ...existing }, proof, stale });
      }
      const requisition = `${input.ats}:${input.postingId}`;
      if (requisitions.has(requisition)) return err({ kind: "DuplicateRequisition" as const });
      const s: SubmissionView = {
        submissionId: randomUUID(),
        applicationId: input.applicationId,
        decisionId: input.decisionId,
        ats: input.ats,
        status: "in_progress",
        reason: null,
        startedAt: new Date(),
        finishedAt: null,
      };
      submissions.push(s);
      keys.set(key, s);
      requisitions.add(requisition);
      return ok({ claimed: true as const, submission: { ...s } });
    },
    recordSubmitted: async (_c, id, proof) => {
      const s = finish(id, "submitted", null);
      if (!s) return err({ kind: "NotInProgress" as const });
      const stored: ProofView = {
        proofId: randomUUID(),
        submissionId: id,
        confirmationHtml: proof.confirmationHtml,
        htmlSha256: sha(new TextEncoder().encode(proof.confirmationHtml)),
        screenshotPng: proof.screenshotPng,
        screenshotSha256: sha(proof.screenshotPng),
        fieldValues: proof.fieldValues,
        resumeSha256: proof.resumeSha256,
        capturedAt: new Date(),
      };
      proofs.push(stored);
      return ok({ submission: { ...s }, proof: stored });
    },
    recordNeedsHuman: async (_c, id, reason) => {
      const s = finish(id, "needs_human", reason);
      return s ? ok({ ...s }) : err({ kind: "NotInProgress" as const });
    },
    transitionApplication: async (input) => {
      if (input.to === "submitted") submittedVia.push(input.submittedVia ?? "missing");
      if (input.from !== status) {
        return err({
          kind: "StaleStatus" as const,
          applicationId: input.applicationId,
          expected: input.from,
          actual: status,
        });
      }
      const next = nextStatus(input.from, input.to);
      if (!next.ok) return next;
      status = next.value;
      // The gateway only reads ok/error from a transition.
      return ok({ replayed: false } as never);
    },
    readFile: async (hash) => files.get(hash) ?? null,
    openDriver: () => driver,
    isSubsystemOn: async (_c, subsystem) => {
      checks.push(subsystem);
      return !(script.switchesOff ?? []).includes(subsystem);
    },
    acquireCall: async (_c, dependency) => {
      checks.push(dependency);
      return script.breaker ? script.breaker(dependency) : { allowed: true, probe: false };
    },
    recordCallOutcome: async (_c, dependency, outcome, probeToken) => {
      reports.push({ dependency, outcome, probeToken });
    },
  };

  return {
    ports,
    status: () => status,
    submissions,
    proofs,
    driverCalls,
    reports,
    checks,
    submittedVia,
    approve: (pkg, refusal) => {
      const id = randomUUID();
      const record = { subject: packageSubject(pkg), hash: packageSha256(pkg) };
      approvals.set(id, refusal ? { ...record, refusal } : record);
      return id;
    },
  };
}
