import type { VerifyError } from "@northstar/db";
import {
  type CallOutcome,
  type CandidateId,
  err,
  ok,
  type ReplyPackage,
  replyContentSha256,
} from "@northstar/domain";
import { GMAIL_COMPOSE_SCOPE, GmailComposeAccess } from "../access.js";
import type { DraftClaim, MailPorts } from "../gateway.js";

// Synthetic reply drafts and fakes for the draft writer's tests (example.com only, no real mail).

export const CANDIDATE = "00000000-0000-4000-8000-000000000001" as CandidateId;
export const DECISION = "11111111-1111-4111-8111-111111111111";
export const REQUEST = "22222222-2222-4222-8222-222222222222";
export const THREAD = "18c2f0a1b2c3d4e5";

export const PACKAGE: ReplyPackage = {
  gmailMessageId: "18c2f0a1b2c3d4e6",
  threadId: THREAD,
  envelope: {
    to: "recruiter@example.com",
    subject: "Re: Platform engineer role",
    inReplyTo: "<abc123@example.com>",
    references: ["<abc123@example.com>"],
  },
  replyToOtherDomain: false,
  body: "Thanks for reaching out.\nI'd be glad to talk this week.",
  cites: ["atom-1"],
  followUps: [],
};

export function storedDraft(pkg: ReplyPackage = PACKAGE, contentSha256 = replyContentSha256(pkg)) {
  return {
    requestId: REQUEST,
    gmailMessageId: pkg.gmailMessageId,
    threadId: pkg.threadId,
    envelope: pkg.envelope,
    body: pkg.body,
    replyToOtherDomain: pkg.replyToOtherDomain,
    cites: pkg.cites,
    followUps: pkg.followUps,
    contentSha256,
  };
}

export const composeAccess = (scopes: string[] = [GMAIL_COMPOSE_SCOPE]) =>
  new GmailComposeAccess("test-token", scopes);

export type Call = { method: string; url: string; body: string | undefined };

// A fake Gmail: answers each request from `answer` and records what was sent.
export function fakeGmail(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake ledger with the database's semantics: the first claim wins and stays live (another caller
// gets `in_progress`) until its lease ends; a claim past its lease with no recorded draft is
// `unknown`, and a recorded draft is `done`. A test ends a lease with `live.delete`, or seeds a
// stale claim with `rows.set(id, null)` alone.
export const LEASE_END = new Date("2026-11-27T01:00:00Z");
export function fakeLedger() {
  const rows = new Map<string, string | null>();
  const live = new Set<string>();
  return {
    rows,
    live,
    claimDraft: async (_c: CandidateId, decisionId: string): Promise<DraftClaim> => {
      if (!rows.has(decisionId)) {
        rows.set(decisionId, null);
        live.add(decisionId);
        return { state: "new" };
      }
      const draft = rows.get(decisionId);
      if (draft) return { state: "done", draftMessageId: draft };
      return live.has(decisionId)
        ? { state: "in_progress", retryAt: LEASE_END }
        : { state: "unknown" };
    },
    recordDraft: async (_c: CandidateId, decisionId: string, draftMessageId: string) => {
      rows.set(decisionId, draftMessageId);
      live.delete(decisionId);
    },
  };
}

export type FakePortsOptions = {
  fetch: typeof globalThis.fetch;
  draft?: ReturnType<typeof storedDraft> | null;
  refusal?: VerifyError;
  // The request the Gate says the decision approved (REQUEST unless a test says otherwise).
  approvedRequest?: string;
  // A guard whose checks throw (a database error).
  guardThrows?: boolean;
  switchOn?: boolean;
  breakerOpen?: boolean;
  ledger?: ReturnType<typeof fakeLedger>;
};

export function fakePorts(o: FakePortsOptions) {
  const reports: CallOutcome[] = [];
  const verified: unknown[] = [];
  const ledger = o.ledger ?? fakeLedger();
  const ports: MailPorts = {
    readReplyDraft: async () => (o.draft === undefined ? storedDraft() : o.draft),
    verifyApproval: async (input) => {
      verified.push(input);
      if (o.refusal) return err(o.refusal);
      return ok({
        decisionId: DECISION,
        requestId: o.approvedRequest ?? REQUEST,
        decidedBy: "user" as const,
        effectiveAt: new Date(0),
      });
    },
    claimDraft: ledger.claimDraft,
    recordDraft: ledger.recordDraft,
    guard: () => ({
      isOn: async () => {
        if (o.guardThrows) throw new Error("connection refused");
        return o.switchOn ?? true;
      },
      acquire: async () =>
        o.breakerOpen
          ? { allowed: false, retryAt: new Date(60_000), lastError: null }
          : { allowed: true, probe: false },
      report: async (_d, outcome) => {
        reports.push(outcome);
      },
    }),
    fetch: o.fetch,
  };
  return { ports, reports, verified, ledger };
}

// Gmail's answer to drafts.create.
export const created = (messageId = "18c2f0a1b2c3d4ff"): Response =>
  json(200, { id: "r-123", message: { id: messageId, threadId: THREAD } });
