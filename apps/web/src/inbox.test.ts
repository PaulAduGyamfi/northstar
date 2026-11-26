import { describe, expect, it } from "vitest";
import {
  applicationTitle,
  type InboxApplicationView,
  InboxBody,
  originBadge,
  queuedRows,
  statusWord,
  threadRows,
} from "./inbox";

// The inbox page's plain decisions (NS-165). Synthetic threads only.
const NOW = Date.parse("2026-11-25T14:00:00Z");

const APP: InboxApplicationView = {
  applicationId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
  jobTitle: "Backend Engineer",
  company: "Example Corp",
  status: "rejected",
  startedBy: "northstar",
  submittedVia: "approved",
  threads: [
    {
      gmailThreadId: "aa01",
      gmailUrl: "https://mail.google.com/mail/u/0/#all/aa01",
      messages: 2,
      lastReceivedAt: "2026-11-25T12:00:00Z",
      step: "tag",
      senderVerified: false,
      kind: null,
    },
    {
      gmailThreadId: "aa02",
      gmailUrl: "javascript:alert(1)",
      messages: 1,
      lastReceivedAt: "2026-11-25T13:59:30Z",
      step: "sender",
      senderVerified: true,
      kind: "interview_request",
    },
  ],
};

describe("threadRows", () => {
  it("says how each thread was linked, its count, when, and that it isn't classified yet", () => {
    expect(threadRows(APP, NOW)).toEqual([
      {
        key: "aa01",
        href: "https://mail.google.com/mail/u/0/#all/aa01",
        messages: "2 messages",
        received: "last one 2 h ago",
        linked: "Linked by its tagged address",
        unverified: "sender not verified",
        kind: "Not classified yet",
      },
      {
        key: "aa02",
        // Not an https Gmail link: the row shows no link at all.
        href: null,
        messages: "1 message",
        received: "last one just now",
        linked: "Linked by the company's domain",
        unverified: "",
        kind: "interview request",
      },
    ]);
  });
});

describe("queuedRows", () => {
  it("says why a thread waits for Paul, and never links outside Gmail", () => {
    expect(
      queuedRows(
        [
          {
            gmailThreadId: "cc01",
            gmailUrl: "https://evil.example.com/#all/cc01",
            messages: 3,
            lastReceivedAt: "2026-11-24T14:00:00Z",
            reason: "ambiguous",
          },
        ],
        NOW,
      ),
    ).toEqual([
      {
        key: "cc01",
        href: null,
        messages: "3 messages",
        received: "last one 1 day ago",
        why: "This thread could belong to more than one application",
      },
    ]);
  });
});

describe("originBadge", () => {
  it("says who started the application and how it went out", () => {
    const badge = (
      startedBy: InboxApplicationView["startedBy"],
      submittedVia: InboxApplicationView["submittedVia"],
    ) => originBadge({ startedBy, submittedVia });
    expect([
      badge("northstar", "auto"),
      badge("northstar", "approved"),
      badge("northstar", "handoff"),
      badge("northstar", "by_hand"),
      badge("northstar", null),
      badge("outside", "by_hand"),
      badge("recruiter_inbound", null),
      badge(null, null),
    ]).toEqual([
      "Started by Northstar · auto-approved",
      "Started by Northstar · you approved",
      "Started by Northstar · you finished it",
      "Started by Northstar · you applied by hand",
      "Started by Northstar",
      "Outside Northstar",
      "From a recruiter",
      "Origin unknown",
    ]);
  });
});

describe("application words", () => {
  it("titles an application by job and company, and shows a rejection as closed", () => {
    expect([
      applicationTitle(APP),
      applicationTitle({ jobTitle: null, company: null }),
      statusWord(APP),
    ]).toEqual(["Backend Engineer at Example Corp", "Untitled job", "closed"]);
  });
});

describe("InboxBody", () => {
  it("refuses a status the app has no word for", () => {
    const body = { applications: [{ ...APP, status: "lost" }], queued: [] };
    expect(InboxBody.safeParse(body).success).toBe(false);
  });
});
