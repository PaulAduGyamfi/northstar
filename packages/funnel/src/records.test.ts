import { type FunnelMessageRow, funnelSchema, type ManualRowInput } from "@northstar/db";
import { MAIL_STATUS_KINDS } from "@northstar/domain";
import { MAIL_KINDS, STAGE_SIGNALS } from "@northstar/inbox";
import { describe, expect, it } from "vitest";
import { gmailRecords, mergeRecords, nameKey, placeMessage } from "./records.js";

// Synthetic companies and ids only (the repo is public).
let n = 0;
function msg(over: Partial<FunnelMessageRow> & { at: string }): FunnelMessageRow {
  n += 1;
  const { at, ...rest } = over;
  return {
    id: `id-${n}`,
    gmailId: `g-${n}`,
    threadId: `t-${n}`,
    senderDomain: "example.com",
    receivedAt: new Date(at),
    status: "classified",
    kind: "confirmation",
    company: "Globex",
    role: "Backend Engineer",
    requisition: null,
    stageSignal: "none",
    classifiedBy: "model",
    reviewReason: null,
    promptVersion: 1,
    model: "claude-opus-5-5",
    ...rest,
  };
}
const NOW = new Date("2026-11-01T00:00:00Z");

describe("message kinds", () => {
  it("the inbox route and the database agree on every kind and stage", () => {
    expect([...MAIL_KINDS]).toEqual([...funnelSchema.MAIL_KINDS]);
    expect([...STAGE_SIGNALS]).toEqual([...funnelSchema.STAGE_SIGNALS]);
  });

  it("the domain's status rules know exactly the inbox route's kinds", () => {
    expect([...MAIL_STATUS_KINDS].sort()).toEqual([...MAIL_KINDS].sort());
  });
});

describe("nameKey", () => {
  it("ignores case, punctuation, accents and a trailing company suffix", () => {
    expect(nameKey("Globex, Inc.")).toBe("globex");
    expect(nameKey("Café Labs LLC")).toBe("cafe labs");
    expect(nameKey(null)).toBe("");
  });
});

describe("placeMessage", () => {
  const confirm = msg({ at: "2026-03-01T10:00:00Z", threadId: "t-a" });
  const groups = [{ messages: [confirm] }];

  it("puts a message in the group with the same thread", () => {
    const reply = msg({
      at: "2026-03-05T10:00:00Z",
      threadId: "t-a",
      company: "Other",
      role: null,
    });
    expect(placeMessage(groups, reply)).toEqual({ kind: "existing", index: 0 });
  });

  it("matches the same company and role within 120 days", () => {
    expect(
      placeMessage(groups, msg({ at: "2026-06-29T10:00:00Z", company: "GLOBEX inc" })),
    ).toEqual({
      kind: "existing",
      index: 0,
    });
  });

  it("starts a new application after 120 days", () => {
    expect(placeMessage(groups, msg({ at: "2026-07-01T10:00:00Z" }))).toEqual({ kind: "new" });
  });

  it("matches a requisition id before the role", () => {
    const withReq = [
      { messages: [msg({ at: "2026-03-01T10:00:00Z", requisition: "R-7", role: "SWE" })] },
    ];
    const m = msg({ at: "2026-03-09T10:00:00Z", requisition: "r-7", role: "Software Engineer" });
    expect(placeMessage(withReq, m)).toEqual({ kind: "existing", index: 0 });
  });

  it("a message with no role joins the one recent group for its company", () => {
    expect(placeMessage(groups, msg({ at: "2026-03-20T10:00:00Z", role: null }))).toEqual({
      kind: "existing",
      index: 0,
    });
  });

  it("a message naming a role joins the company's recent application that has no role yet", () => {
    const roleless = [
      { messages: [msg({ at: "2026-03-01T10:00:00Z", threadId: "t-conf", role: null })] },
    ];
    const interview = msg({
      at: "2026-03-08T10:00:00Z",
      threadId: "t-new",
      role: "Backend Engineer",
    });
    expect(placeMessage(roleless, interview)).toEqual({ kind: "existing", index: 0 });
    const both = gmailRecords([...(roleless[0]?.messages ?? []), interview], NOW);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({
      role: "Backend Engineer",
      appliedAt: new Date("2026-03-01T10:00:00Z"),
    });
  });

  it("a message with no role is ambiguous when the company has two recent applications", () => {
    const two = [
      { messages: [msg({ at: "2026-03-01T10:00:00Z", role: "Backend Engineer" })] },
      { messages: [msg({ at: "2026-03-02T10:00:00Z", role: "Data Engineer" })] },
    ];
    expect(placeMessage(two, msg({ at: "2026-03-20T10:00:00Z", role: null }))).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });
});

describe("gmailRecords", () => {
  it("a confirmation alone is an open application at stage applied", () => {
    const [r] = gmailRecords([msg({ at: "2026-10-20T10:00:00Z" })], NOW);
    expect(r).toMatchObject({ stage: "applied", outcome: "open", source: "gmail", channel: null });
  });

  it("keeps the furthest stage and the rejection that ended it", () => {
    const t = "t-flow";
    const records = gmailRecords(
      [
        msg({ at: "2026-03-01T10:00:00Z", threadId: t }),
        msg({
          at: "2026-03-08T10:00:00Z",
          threadId: t,
          kind: "interview_request",
          stageSignal: "screen",
        }),
        msg({
          at: "2026-03-15T10:00:00Z",
          threadId: t,
          kind: "assessment",
          stageSignal: "technical",
        }),
        msg({ at: "2026-03-30T10:00:00Z", threadId: t, kind: "rejection" }),
      ],
      NOW,
    );
    expect(records).toEqual([
      {
        company: "Globex",
        role: "Backend Engineer",
        appliedAt: new Date("2026-03-01T10:00:00Z"),
        stage: "technical",
        outcome: "rejected",
        outcomeAt: new Date("2026-03-30T10:00:00Z"),
        channel: null,
        source: "gmail",
      },
    ]);
  });

  it("a templated rejection alone doesn't count as a response", () => {
    const t = "t-r";
    const [r] = gmailRecords(
      [
        msg({ at: "2026-03-01T10:00:00Z", threadId: t }),
        msg({ at: "2026-03-01T20:00:00Z", threadId: t, kind: "rejection" }),
      ],
      NOW,
    );
    expect(r?.stage).toBe("applied");
  });

  it("is ghosted only after more than 30 days of silence", () => {
    const at30 = gmailRecords([msg({ at: "2026-10-02T00:00:00Z" })], NOW);
    const at31 = gmailRecords(
      [msg({ at: "2026-10-01T00:00:00Z" })],
      new Date("2026-11-01T00:00:01Z"),
    );
    expect(at30[0]?.outcome).toBe("open");
    expect(at31[0]?.outcome).toBe("ghosted");
  });

  it("an offer message makes the stage and the outcome offer", () => {
    const [r] = gmailRecords(
      [msg({ at: "2026-03-01T10:00:00Z", kind: "offer", stageSignal: "offer" })],
      NOW,
    );
    expect(r).toMatchObject({ stage: "offer", outcome: "offer" });
  });

  it("a recruiter's first message marks the channel recruiter_inbound", () => {
    const [r] = gmailRecords([msg({ at: "2026-03-01T10:00:00Z", kind: "recruiter_inbound" })], NOW);
    expect(r).toMatchObject({ channel: "recruiter_inbound", stage: "responded" });
  });

  it("leaves out messages that aren't classified", () => {
    expect(
      gmailRecords([msg({ at: "2026-03-01T10:00:00Z", status: "needs_review" })], NOW),
    ).toEqual([]);
  });
});

describe("mergeRecords", () => {
  const gmail = gmailRecords([msg({ at: "2026-04-03T10:00:00Z", kind: "rejection" })], NOW);
  const row: ManualRowInput = {
    line: 2,
    company: "Globex Inc",
    role: "Backend Engineer",
    appliedOn: "2026-04-01",
    stageReached: "screen",
    outcome: "rejected",
    outcomeOn: "2026-04-20",
    channel: "referral",
  };

  it("merges a tracker row into the Gmail record within 14 days, keeping the furthest stage", () => {
    const { records, conflicts } = mergeRecords(gmail, [row]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "both", stage: "screen", channel: "referral" });
    expect(conflicts).toEqual([]);
  });

  it("lists a conflict when the tracker and Gmail disagree on the outcome, and keeps the tracker's", () => {
    const { records, conflicts } = mergeRecords(gmail, [
      { ...row, outcome: "offer", stageReached: "offer" },
    ]);
    expect(records[0]?.outcome).toBe("offer");
    expect(conflicts).toEqual([
      {
        company: "Globex Inc",
        role: "Backend Engineer",
        trackerOutcome: "offer",
        gmailOutcome: "rejected",
      },
    ]);
  });

  it("keeps a row outside the 14-day window as its own record", () => {
    const { records } = mergeRecords(gmail, [{ ...row, appliedOn: "2026-05-01" }]);
    expect(records.map((r) => r.source)).toEqual(["gmail", "manual"]);
  });
});
