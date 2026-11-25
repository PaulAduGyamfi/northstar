import type {
  FunnelMessageInput,
  FunnelMessageRow,
  FunnelOutcome,
  FunnelStage,
} from "@northstar/db";
import {
  type GmailClient,
  isJobMail,
  type MailClassification,
  type MailClassifyInput,
  type MessageHeaders,
  senderDomain,
} from "@northstar/inbox";
import type { CallRecord, LlmGateway, LlmOutcome, Route } from "@northstar/llm";
import type { BackfillStore } from "../backfill.js";

// A synthetic 9-month mailbox (NS-113): 12 invented applications, newsletters and one job alert.
// Every sender is at example.com and every company is made up (the repo is public). Each message
// carries the classification a correct model would return, so the backfill runs with no model.
// Senders use the reserved .example top-level domain (RFC 2606), one domain per company.

export type FakeMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  headers: Record<string, string>;
  text: string;
  // The sender's domain as Gmail would parse it from From. Set it only to test a vendor's own
  // domain (an ATS) without writing an address there: the repo's fixtures hold no real-looking
  // addresses. Otherwise it is read from the From header.
  senderDomain?: string;
};

type Step = {
  at: string;
  from?: string;
  subject: string;
  body: string;
  answer: MailClassification | null; // null: a rule handles it (or the pre-filter drops it)
};

export type Expected = { company: string; stage: FunnelStage; outcome: FunnelOutcome };

const conf = (company: string, role: string, at: string): Step => ({
  at,
  subject: `Thank you for applying for the ${role} role at ${company}`,
  body: `We received your application for ${role}.`,
  answer: null,
});
const m = (
  at: string,
  subject: string,
  body: string,
  kind: MailClassification["kind"],
  company: string,
  stageSignal: MailClassification["stageSignal"] = "none",
  role: string | null = null,
): Step => ({ at, subject, body, answer: { kind, company, role, requisition: null, stageSignal } });

const apps: { company: string; steps: Step[]; expected: Expected }[] = [
  {
    company: "Globex",
    steps: [
      conf("Globex", "Backend Engineer", "2026-02-03T15:00:00Z"),
      m(
        "2026-02-10T15:00:00Z",
        "Globex - quick chat?",
        "A recruiter at Globex would like a call.",
        "interview_request",
        "Globex",
        "screen",
      ),
      m(
        "2026-02-20T15:00:00Z",
        "Technical interview",
        "Globex invites you to a technical interview.",
        "interview_request",
        "Globex",
        "technical",
      ),
      m(
        "2026-03-05T15:00:00Z",
        "Update on your application",
        "Globex decided not to move forward.",
        "rejection",
        "Globex",
      ),
    ],
    expected: { company: "Globex", stage: "technical", outcome: "rejected" },
  },
  {
    company: "Initech",
    steps: [
      conf("Initech", "Platform Engineer", "2026-02-05T09:00:00Z"),
      m(
        "2026-02-05T19:00:00Z",
        "Your application to Initech",
        "Initech will not move forward.",
        "rejection",
        "Initech",
      ),
    ],
    expected: { company: "Initech", stage: "applied", outcome: "rejected" },
  },
  {
    company: "Hooli",
    steps: [
      m(
        "2026-02-12T12:00:00Z",
        "Thanks for applying!",
        "Hooli received your application for Data Engineer.",
        "confirmation",
        "Hooli",
        "none",
        "Data Engineer",
      ),
    ],
    expected: { company: "Hooli", stage: "applied", outcome: "ghosted" },
  },
  {
    company: "Umbrella Labs",
    steps: [
      conf("Umbrella Labs", "Software Engineer", "2026-03-01T10:00:00Z"),
      m(
        "2026-03-08T10:00:00Z",
        "Intro call",
        "Umbrella Labs recruiting would like a 30-minute call.",
        "interview_request",
        "Umbrella Labs",
        "screen",
      ),
      m(
        "2026-03-18T10:00:00Z",
        "Coding round",
        "Umbrella Labs: your coding round is next week.",
        "scheduling",
        "Umbrella Labs",
        "technical",
      ),
      m(
        "2026-04-01T10:00:00Z",
        "Final round",
        "Umbrella Labs invites you to the final round.",
        "interview_request",
        "Umbrella Labs",
        "onsite",
      ),
      m(
        "2026-04-15T10:00:00Z",
        "Great news",
        "Umbrella Labs would like to extend an offer.",
        "offer",
        "Umbrella Labs",
        "offer",
      ),
    ],
    expected: { company: "Umbrella Labs", stage: "offer", outcome: "offer" },
  },
  {
    company: "Stark Systems",
    steps: [
      conf("Stark Systems", "Site Reliability Engineer", "2026-03-03T08:00:00Z"),
      m(
        "2026-03-08T08:00:00Z",
        "Your candidacy",
        "Stark Systems is pursuing other candidates.",
        "rejection",
        "Stark Systems",
      ),
    ],
    expected: { company: "Stark Systems", stage: "applied", outcome: "rejected" },
  },
  {
    company: "Vandelay Industries",
    steps: [
      conf("Vandelay Industries", "Backend Engineer", "2026-03-10T14:00:00Z"),
      m(
        "2026-03-17T14:00:00Z",
        "Next steps",
        "Vandelay Industries hiring manager wants to talk.",
        "interview_request",
        "Vandelay Industries",
        "screen",
      ),
      m(
        "2026-04-02T14:00:00Z",
        "Following up",
        "Vandelay Industries will not proceed.",
        "rejection",
        "Vandelay Industries",
      ),
    ],
    expected: { company: "Vandelay Industries", stage: "screen", outcome: "rejected" },
  },
  {
    company: "Acme Robotics",
    steps: [
      conf("Acme Robotics", "ML Engineer", "2026-04-06T11:00:00Z"),
      m(
        "2026-04-13T11:00:00Z",
        "Coding challenge",
        "Acme Robotics invites you to a coding challenge.",
        "assessment",
        "Acme Robotics",
        "technical",
      ),
    ],
    expected: { company: "Acme Robotics", stage: "technical", outcome: "ghosted" },
  },
  {
    company: "Wayne Tech",
    steps: [
      m(
        "2026-05-04T16:00:00Z",
        "Interview invitation from Wayne Tech",
        "A recruiter at Wayne Tech saw your profile.",
        "recruiter_inbound",
        "Wayne Tech",
      ),
      m(
        "2026-05-11T16:00:00Z",
        "Call confirmed",
        "Your Wayne Tech recruiter call is confirmed.",
        "scheduling",
        "Wayne Tech",
        "screen",
      ),
      m(
        "2026-05-25T16:00:00Z",
        "Thank you",
        "Wayne Tech has decided to move forward with others.",
        "rejection",
        "Wayne Tech",
      ),
    ],
    expected: { company: "Wayne Tech", stage: "screen", outcome: "rejected" },
  },
  {
    company: "Soylent Foods",
    steps: [
      conf("Soylent Foods", "Backend Engineer", "2026-06-01T09:00:00Z"),
      m(
        "2026-06-01T11:00:00Z",
        "Your application to Soylent Foods",
        "Soylent Foods will not be moving forward.",
        "rejection",
        "Soylent Foods",
      ),
    ],
    expected: { company: "Soylent Foods", stage: "applied", outcome: "rejected" },
  },
  {
    company: "Cyberdyne",
    steps: [conf("Cyberdyne", "Infrastructure Engineer", "2026-10-20T09:00:00Z")],
    expected: { company: "Cyberdyne", stage: "applied", outcome: "open" },
  },
  {
    company: "Tyrell Labs",
    steps: [
      conf("Tyrell Labs", "Full Stack Engineer", "2026-07-06T09:00:00Z"),
      m(
        "2026-07-10T09:00:00Z",
        "Action needed",
        "Tyrell Labs needs your work authorization answers.",
        "follow_up_needed",
        "Tyrell Labs",
      ),
      m(
        "2026-07-24T09:00:00Z",
        "Application update",
        "Tyrell Labs filled the role.",
        "rejection",
        "Tyrell Labs",
      ),
    ],
    expected: { company: "Tyrell Labs", stage: "responded", outcome: "rejected" },
  },
  {
    company: "Massive Dynamic",
    steps: [
      conf("Massive Dynamic", "API Engineer", "2026-08-03T13:00:00Z"),
      m(
        "2026-08-10T13:00:00Z",
        "Interview invitation",
        "Massive Dynamic would like a phone screen.",
        "interview_request",
        "Massive Dynamic",
        "screen",
      ),
      m(
        "2026-08-12T13:00:00Z",
        "Confirmed: phone screen",
        "Massive Dynamic phone screen confirmed.",
        "scheduling",
        "Massive Dynamic",
        "screen",
      ),
      m(
        "2026-08-24T13:00:00Z",
        "Technical interview",
        "Massive Dynamic technical interview next week.",
        "interview_request",
        "Massive Dynamic",
        "technical",
      ),
      m(
        "2026-09-07T13:00:00Z",
        "Your application",
        "Massive Dynamic will not move forward.",
        "rejection",
        "Massive Dynamic",
      ),
    ],
    expected: { company: "Massive Dynamic", stage: "technical", outcome: "rejected" },
  },
];

// Not job mail: the pre-filter drops these from their headers alone.
const newsletters: Step[] = [
  { at: "2026-02-14T07:00:00Z", subject: "Weekend sale: 30% off", body: "Shop now.", answer: null },
  { at: "2026-05-02T07:00:00Z", subject: "Dinner on Friday?", body: "Are you free?", answer: null },
  {
    at: "2026-09-01T07:00:00Z",
    subject: "Your monthly statement",
    body: "Statement ready.",
    answer: null,
  },
];
// Passes the pre-filter ("your application" in the subject), but the model says it's a job alert.
const jobAlert = m(
  "2026-06-15T07:00:00Z",
  "Job offer alert: 10 new roles for you",
  "Job board tips.",
  "info_other",
  "JobBoard",
);
// The model names an employer that isn't in the email: the provenance check sends it to review.
export const badExtraction = m(
  "2026-06-20T07:00:00Z",
  "Phone screen next week",
  "The team would like to meet you.",
  "interview_request",
  "Oscorp",
  "screen",
);

export const EXPECTED: Expected[] = apps.map((a) => a.expected);
export const NOW = new Date("2026-11-01T00:00:00Z");

export function mailbox(): { messages: FakeMessage[]; answers: Map<string, MailClassification> } {
  const messages: FakeMessage[] = [];
  const answers = new Map<string, MailClassification>();
  let i = 0;
  const add = (s: Step, thread: string, from: string, verified: string | null = null) => {
    i += 1;
    const id = `msg-${String(i).padStart(3, "0")}`;
    messages.push({
      id,
      threadId: thread,
      internalDate: s.at,
      headers: {
        From: s.from ?? from,
        Subject: s.subject,
        Date: s.at,
        // Company mail passes DMARC; the newsletters and the stray sender carry no verdict.
        ...(verified
          ? { "Authentication-Results": `mx.example; dmarc=pass header.from=${verified}` }
          : {}),
      },
      text: s.body,
    });
    if (s.answer) answers.set(id, s.answer);
  };
  for (const [n, a] of apps.entries()) {
    const domain = a.company.toLowerCase().replace(/[^a-z]/g, "");
    for (const s of a.steps) {
      add(s, `thread-${n}`, `${a.company} <careers@${domain}.example>`, `${domain}.example`);
    }
  }
  for (const [n, s] of newsletters.entries()) add(s, `news-${n}`, "");
  add(jobAlert, "alert", "JobBoard <tips@jobboard.example>");
  add(badExtraction, "bad", "Talent <talent@unknown.example>");
  return { messages, answers };
}

export function record(over: Partial<CallRecord> = {}): CallRecord {
  return {
    route: "mail-classify",
    promptId: "mail-classify",
    promptVersion: 1,
    modelRequested: "claude-opus-5-5",
    modelServed: "claude-opus-5-5",
    effort: "low",
    inputTokens: 900,
    outputTokens: 60,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 1200,
    costUsd: 0.01,
    stopReason: "end_turn",
    refusalCategory: null,
    fallbackUsed: false,
    ...over,
  };
}

// A gateway that answers from the script by subject (no model, no network) and counts its calls.
export function scriptedGateway(
  answer: (input: MailClassifyInput) => LlmOutcome<MailClassification> | Error,
): LlmGateway & { calls: MailClassifyInput[] } {
  const calls: MailClassifyInput[] = [];
  return {
    calls,
    call: (async (_route: Route<unknown, unknown>, input: unknown) => {
      calls.push(input as MailClassifyInput);
      const out = answer(input as MailClassifyInput);
      if (out instanceof Error) throw out;
      return out;
    }) as LlmGateway["call"],
  };
}

// An in-memory BackfillStore with the database's rules: one row per Gmail id, first write wins.
export function memoryStore(): BackfillStore & { rows: FunnelMessageInput[] } {
  const rows: FunnelMessageInput[] = [];
  return {
    rows,
    knownIds: async (ids) => new Set(ids.filter((id) => rows.some((r) => r.gmailId === id))),
    save: async (msg) => {
      if (!rows.some((r) => r.gmailId === msg.gmailId)) rows.push(msg);
    },
    messages: async () =>
      rows
        .filter((r) => r.status !== "not_job")
        .map(
          (r): FunnelMessageRow => ({
            ...r,
            id: r.gmailId,
            status: r.status === "classified" ? "classified" : "needs_review",
          }),
        ),
  };
}

// A GmailClient over the fake mailbox. It records which messages were fetched in full, so a test
// can prove non-job mail never was.
export function fakeGmailClient(messages: FakeMessage[]): GmailClient & { fullFetches: string[] } {
  const fullFetches: string[] = [];
  const byId = (id: string) => {
    const msg = messages.find((x) => x.id === id);
    if (!msg) throw new Error(`no message ${id}`);
    return msg;
  };
  const headersOf = (msg: FakeMessage): MessageHeaders => ({
    id: msg.id,
    threadId: msg.threadId,
    from: msg.headers.From ?? "",
    senderDomain: msg.senderDomain ?? senderDomain(msg.headers.From ?? ""),
    subject: msg.headers.Subject ?? "",
    deliveredTo: null,
    authenticationResults: msg.headers["Authentication-Results"] ?? null,
    receivedAt: new Date(msg.internalDate),
  });
  return {
    fullFetches,
    // Like Gmail: only messages matching the search (approximated by the same rule the search
    // encodes: a verified ATS sender or a job-specific subject phrase), newest first.
    listIds: async () =>
      [...messages]
        .filter((x) => isJobMail(headersOf(x), new Set()))
        .sort((a, b) => b.internalDate.localeCompare(a.internalDate))
        .map((x) => ({ id: x.id, threadId: x.threadId })),
    threadMessageIds: async (threadId) =>
      messages
        .filter((x) => x.threadId === threadId)
        .map((x) => ({ id: x.id, threadId: x.threadId })),
    getHeaders: async (id) => headersOf(byId(id)),
    getFull: async (id) => {
      fullFetches.push(id);
      const msg = byId(id);
      return { ...headersOf(msg), body: msg.text };
    },
  };
}
