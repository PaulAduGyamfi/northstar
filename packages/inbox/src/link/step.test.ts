import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MessageHeaders } from "../gmail.js";
import type { VerificationWindow } from "../verify/catcher.js";
import {
  type CandidateRow,
  isStampedDelivery,
  type LinkDecision,
  type LinkStepDeps,
  linkNewMessage,
  mailboxKey,
  toLinkCandidate,
} from "./step.js";

// The mail-link step on fakes (#224). Synthetic addresses and ids only (the repo is public).

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

const MAILBOX = "candidate@example.com";
const AT = new Date("2026-11-25T12:00:00Z");
const APP = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

const mail = (over: Partial<MessageHeaders> = {}): MessageHeaders => ({
  id: "m1",
  threadId: "t1",
  from: "Globex Recruiting <talent@globex.example.com>",
  senderDomain: "globex.example.com",
  subject: "Next steps for your application",
  deliveredTo: "candidate+ns-k3q2m7@example.com",
  authenticationResults: "mx.google.com; dmarc=pass header.from=globex.example.com",
  receivedAt: AT,
  labelIds: ["INBOX"],
  ...over,
});

const window = (over: Partial<VerificationWindow> = {}): { window: VerificationWindow } => ({
  window: {
    id: "w1",
    tenant: "globex",
    ats: "workday",
    purpose: "sign_up",
    senderDomains: ["myworkday.com"],
    linkHosts: ["globex.wd5.myworkdayjobs.com"],
    openedAt: new Date(AT.getTime() - 60_000),
    expiresAt: new Date(AT.getTime() + 60_000),
    ...over,
  },
});

type Recorded = { message: { id: string }; decision: LinkDecision };

const fakeDeps = (over: Partial<LinkStepDeps> = {}) => {
  const recorded: Recorded[] = [];
  const seen = new Set<string>();
  const deps: LinkStepDeps = {
    mailbox: MAILBOX,
    openWindows: async () => [],
    readTags: async () => [{ tag: "k3q2m7", applicationId: APP, tenantKey: null }],
    readCandidates: async (): Promise<CandidateRow[]> => [
      { applicationId: APP, createdAt: new Date("2026-11-01T00:00:00Z"), ats: ["greenhouse"] },
      { applicationId: OTHER, createdAt: new Date("2026-11-01T00:00:00Z"), ats: [] },
    ],
    readLinkedThreads: async () => new Map(),
    record: async (input) => {
      // Like recordMailLink: once per message id.
      if (seen.has(input.message.id)) return { recorded: false };
      seen.add(input.message.id);
      recorded.push(input);
      return { recorded: true };
    },
    ...over,
  };
  return { deps, recorded };
};

beforeEach(() => exporter.reset());

describe("linkNewMessage", () => {
  it("links tagged mail Gmail delivered to Paul's mailbox and records it once", async () => {
    const { deps, recorded } = fakeDeps();
    const first = await linkNewMessage(deps, mail());
    const again = await linkNewMessage(deps, mail());
    expect([first, again]).toEqual([
      { kind: "linked", applicationId: APP, step: "tag", recorded: true },
      { kind: "linked", applicationId: APP, step: "tag", recorded: false },
    ]);
    expect(recorded).toEqual([
      {
        message: { id: "m1", threadId: "t1", receivedAt: AT },
        decision: { kind: "linked", applicationId: APP, step: "tag", senderVerified: false },
      },
    ]);
  });

  it("links mail in a thread already linked to one application", async () => {
    const { deps } = fakeDeps({ readLinkedThreads: async () => new Map([[OTHER, ["t1"]]]) });
    expect(await linkNewMessage(deps, mail({ deliveredTo: MAILBOX }))).toEqual({
      kind: "linked",
      applicationId: OTHER,
      step: "thread",
      recorded: true,
    });
  });

  it("queues untagged mail from a new thread for Paul, since no company domain is stored yet", async () => {
    const { deps, recorded } = fakeDeps();
    expect(await linkNewMessage(deps, mail({ deliveredTo: MAILBOX }))).toEqual({
      kind: "queued",
      reason: "no_match",
      recorded: true,
    });
    expect(recorded.map((r) => r.decision)).toEqual([{ kind: "queued", reason: "no_match" }]);
  });

  it("marks a tagged link sender-verified when Gmail authenticated the application's ATS", async () => {
    const { deps, recorded } = fakeDeps();
    await linkNewMessage(
      deps,
      mail({
        senderDomain: "greenhouse-mail.io",
        authenticationResults: "mx.google.com; dmarc=pass header.from=greenhouse-mail.io",
      }),
    );
    expect(recorded[0]?.decision).toEqual({
      kind: "linked",
      applicationId: APP,
      step: "tag",
      senderVerified: true,
    });
  });

  // Headers with no labels at all, as a caller that built them itself would pass.
  const unlabelled = (): MessageHeaders => {
    const { labelIds: _dropped, ...rest } = mail();
    return rest;
  };

  it.each<[string, () => MessageHeaders]>([
    ["sent mail", () => mail({ labelIds: ["SENT"] })],
    ["a draft", () => mail({ labelIds: ["DRAFT", "INBOX"] })],
    ["mail with unknown labels", unlabelled],
    ["mail with no Delivered-To", () => mail({ deliveredTo: null })],
    [
      "mail delivered to another mailbox",
      () => mail({ deliveredTo: "someone+ns-k3q2m7@example.com" }),
    ],
  ])("skips %s and stores nothing", async (_name, headers) => {
    const { deps, recorded } = fakeDeps();
    expect(await linkNewMessage(deps, headers())).toEqual({ kind: "skipped", reason: "unstamped" });
    expect(recorded).toEqual([]);
  });

  it("leaves mail an open verification window is waiting for to the Catcher", async () => {
    const { deps, recorded } = fakeDeps({ openWindows: async () => [window()] });
    const workday = mail({
      senderDomain: "myworkday.com",
      authenticationResults: "mx.google.com; dmarc=pass header.from=myworkday.com",
      subject: "Your application",
    });
    expect(await linkNewMessage(deps, workday)).toEqual({
      kind: "skipped",
      reason: "verification_window",
    });
    expect(recorded).toEqual([]);
  });

  it("links the same mail once its window has closed", async () => {
    const { deps } = fakeDeps({
      openWindows: async () => [window({ expiresAt: new Date(AT.getTime() - 1) })],
    });
    const workday = mail({
      senderDomain: "myworkday.com",
      authenticationResults: "mx.google.com; dmarc=pass header.from=myworkday.com",
      subject: "Your application",
    });
    expect((await linkNewMessage(deps, workday)).kind).toBe("linked");
  });

  it("skips verification mail by its headers and stores nothing", async () => {
    const { deps, recorded } = fakeDeps();
    const verify = mail({
      senderDomain: "myworkday.com",
      subject: "Verify your email address",
    });
    expect(await linkNewMessage(deps, verify)).toEqual({ kind: "skipped", reason: "verification" });
    expect(recorded).toEqual([]);
  });

  it("reads nothing from the database for mail it skips as unstamped", async () => {
    let reads = 0;
    const count = async () => {
      reads++;
      return [];
    };
    const { deps } = fakeDeps({ openWindows: count, readTags: count, readCandidates: count });
    await linkNewMessage(deps, mail({ labelIds: ["SENT"] }));
    expect(reads).toBe(0);
  });

  it("puts only the outcome on its span, never an address or subject", async () => {
    const { deps } = fakeDeps();
    await linkNewMessage(deps, mail());
    const span = exporter.getFinishedSpans().find((s) => s.name === "mail.link");
    expect(span?.attributes).toEqual({
      "northstar.mail_link.outcome": "tag",
      "northstar.mail_link.recorded": true,
    });
  });
});

describe("isStampedDelivery", () => {
  it("accepts Paul's own Gmail address however its dots and domain are written", () => {
    const headers = mail({ deliveredTo: "Some.Candidate+ns-k3q2m7@googlemail.com" });
    expect(isStampedDelivery(headers, "somecandidate@gmail.com")).toBe(true);
  });

  it("keeps dots significant outside Gmail's own domains", () => {
    const headers = mail({ deliveredTo: "some.candidate@example.com" });
    expect(isStampedDelivery(headers, "somecandidate@example.com")).toBe(false);
  });
});

describe("mailboxKey", () => {
  it.each([
    ["Candidate <Candidate+ns-abcdef@Example.com>", "candidate@example.com"],
    ["candidate@example.com", "candidate@example.com"],
    ["not an address", null],
    ["@example.com", null],
    ["+ns-abcdef@example.com", null],
  ])("reads %s as %s", (address, key) => {
    expect(mailboxKey(address)).toBe(key);
  });
});

describe("toLinkCandidate", () => {
  it("gives each ATS's sender domains once, no company domains and no tenant", () => {
    const row = { applicationId: APP, createdAt: AT, ats: ["greenhouse", "workday", "unknown"] };
    expect(toLinkCandidate(row, ["t1"])).toEqual({
      applicationId: APP,
      tenantKey: null,
      threadIds: ["t1"],
      companyDomains: [],
      atsDomains: ["greenhouse.io", "greenhouse-mail.io", "myworkday.com", "myworkdayjobs.com"],
      activeFrom: AT,
      activeUntil: null,
    });
  });
});
