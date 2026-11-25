import { describe, expect, it } from "vitest";
import type { MessageHeaders } from "../gmail.js";
import { type LinkCandidate, matchMail, type TagRow } from "./match.js";

// Synthetic mail and applications only (example.com, invented companies).

const AT = new Date("2026-11-25T12:00:00Z");
const DMARC_ACME = "mx.google.com; dmarc=pass (p=REJECT) header.from=acme.example.com";
const DKIM_GREENHOUSE = "mx.google.com; dkim=pass header.d=greenhouse.io";

const mail = (over: Partial<MessageHeaders> = {}): MessageHeaders => ({
  id: "m1",
  threadId: "t1",
  from: "Acme Recruiting <jobs@acme.example.com>",
  senderDomain: "acme.example.com",
  subject: "Your application to Acme",
  deliveredTo: "candidate@example.com",
  authenticationResults: null,
  receivedAt: AT,
  ...over,
});

const app = (id: string, over: Partial<LinkCandidate> = {}): LinkCandidate => ({
  applicationId: id,
  tenantKey: null,
  threadIds: [],
  companyDomains: [],
  atsDomains: [],
  activeFrom: new Date("2026-11-01T00:00:00Z"),
  activeUntil: null,
  ...over,
});

const ACME = app("app-acme", {
  companyDomains: ["acme.example.com"],
  atsDomains: ["greenhouse.io"],
});
const GLOBEX = app("app-globex", { companyDomains: ["globex.example.com"] });
const TAGS: TagRow[] = [{ tag: "k3q2m7", applicationId: "app-acme", tenantKey: null }];

describe("matchMail step 1: the tag Gmail delivered to", () => {
  it("links mail to candidate+ns-<tag> to its application with step tag", () => {
    const result = matchMail(
      mail({ deliveredTo: "candidate+ns-k3q2m7@example.com", authenticationResults: DMARC_ACME }),
      TAGS,
      [ACME, GLOBEX],
    );
    expect(result).toEqual({
      kind: "linked",
      applicationId: "app-acme",
      step: "tag",
      senderVerified: true,
    });
  });

  it("links a tagged mail from an unauthenticated sender, but not as verified (INB-011)", () => {
    const result = matchMail(mail({ deliveredTo: "candidate+ns-k3q2m7@example.com" }), TAGS, [
      ACME,
    ]);
    expect(result).toEqual({
      kind: "linked",
      applicationId: "app-acme",
      step: "tag",
      senderVerified: false,
    });
  });

  it("queues an unknown tag, never a guess", () => {
    expect(
      matchMail(
        mail({ deliveredTo: "candidate+ns-zzzzzz@example.com", authenticationResults: DMARC_ACME }),
        TAGS,
        [ACME],
      ),
    ).toEqual({ kind: "queued", reason: "unknown_tag", candidateIds: [] });
  });

  it("queues a malformed +ns- part as an unknown tag", () => {
    expect(matchMail(mail({ deliveredTo: "candidate+ns-k3q@example.com" }), TAGS, [ACME])).toEqual({
      kind: "queued",
      reason: "unknown_tag",
      candidateIds: [],
    });
  });

  // MessageHeaders has no To or Cc at all (gmail.ts reads only From, Subject, Date, Delivered-To
  // and Authentication-Results), so a tag there can't be read by construction; this checks the
  // sender-written fields that are read.
  it("reads the tag only from Delivered-To: a tag in the subject or From is ignored", () => {
    const result = matchMail(
      mail({ subject: "Re: candidate+ns-k3q2m7@example.com", from: "x+ns-k3q2m7@evil.example" }),
      TAGS,
      [ACME],
    );
    expect(result).toEqual({ kind: "queued", reason: "no_match", candidateIds: [] });
  });

  describe("a tenant tag shared by two applications", () => {
    const tenantTags: TagRow[] = [
      { tag: "wrkday", applicationId: null, tenantKey: "workday:acme" },
    ];
    const a = app("app-a", { tenantKey: "workday:acme", threadIds: ["t-a"] });
    const b = app("app-b", { tenantKey: "workday:acme", threadIds: ["t-b"] });
    const tagged = (over: Partial<MessageHeaders>) =>
      mail({ deliveredTo: "candidate+ns-wrkday@example.com", ...over });

    it("links when step 2 picks one of them", () => {
      expect(matchMail(tagged({ threadId: "t-b" }), tenantTags, [a, b])).toMatchObject({
        kind: "linked",
        applicationId: "app-b",
        step: "thread",
      });
    });

    it("queues as ambiguous when steps 2–3 can't pick one", () => {
      expect(matchMail(tagged({ threadId: "t-new" }), tenantTags, [a, b])).toEqual({
        kind: "queued",
        reason: "ambiguous",
        candidateIds: ["app-a", "app-b"],
      });
    });
  });
});

describe("matchMail step 2: the thread", () => {
  it("links a reply in a thread already linked to one application", () => {
    const linked = app("app-acme", { threadIds: ["t1"] });
    expect(matchMail(mail(), [], [linked, GLOBEX])).toMatchObject({
      kind: "linked",
      applicationId: "app-acme",
      step: "thread",
    });
  });

  it("queues a thread linked to two applications as ambiguous", () => {
    const x = app("x", { threadIds: ["t1"] });
    const y = app("y", { threadIds: ["t1"] });
    expect(matchMail(mail(), [], [x, y])).toEqual({
      kind: "queued",
      reason: "ambiguous",
      candidateIds: ["x", "y"],
    });
  });
});

describe("matchMail step 3: the authenticated sender", () => {
  it("links mail whose DMARC-passing domain is one application's company", () => {
    expect(matchMail(mail({ authenticationResults: DMARC_ACME }), [], [ACME, GLOBEX])).toEqual({
      kind: "linked",
      applicationId: "app-acme",
      step: "sender",
      senderVerified: true,
    });
  });

  it("never matches a forged From with no DMARC or DKIM pass", () => {
    expect(matchMail(mail({ authenticationResults: null }), [], [ACME])).toEqual({
      kind: "queued",
      reason: "no_match",
      candidateIds: [],
    });
  });

  it("never picks an application by a shared ATS domain alone", () => {
    expect(matchMail(mail({ authenticationResults: DKIM_GREENHOUSE }), [], [ACME])).toEqual({
      kind: "queued",
      reason: "no_match",
      candidateIds: [],
    });
  });

  it("ignores an application outside its active window", () => {
    const closed = app("app-acme", {
      companyDomains: ["acme.example.com"],
      activeUntil: new Date("2026-11-20T00:00:00Z"),
    });
    expect(matchMail(mail({ authenticationResults: DMARC_ACME }), [], [closed])).toMatchObject({
      kind: "queued",
      reason: "no_match",
    });
  });

  it("queues two open applications at the same company as ambiguous", () => {
    const second = app("app-acme-2", { companyDomains: ["acme.example.com"] });
    expect(matchMail(mail({ authenticationResults: DMARC_ACME }), [], [ACME, second])).toEqual({
      kind: "queued",
      reason: "ambiguous",
      candidateIds: ["app-acme", "app-acme-2"],
    });
  });
});

describe("matchMail and verification mail (INB-012)", () => {
  it("skips verification mail even when it carries a known tag", () => {
    const verification = mail({
      deliveredTo: "candidate+ns-k3q2m7@example.com",
      senderDomain: "myworkday.com",
      subject: "Verify your email address",
    });
    expect(matchMail(verification, TAGS, [ACME])).toEqual({ kind: "skip", reason: "verification" });
  });
});

describe("matchMail and sender verification (INB-011: DMARC or aligned DKIM only)", () => {
  const tagged = (over: Partial<MessageHeaders>) =>
    mail({ deliveredTo: "candidate+ns-k3q2m7@example.com", ...over });

  it("doesn't verify a forged From signed only by a shared ATS's DKIM", () => {
    const forged = tagged({
      from: "Acme <jobs@acme.example.com>",
      senderDomain: "acme.example.com",
      authenticationResults: DKIM_GREENHOUSE,
    });
    expect(matchMail(forged, TAGS, [ACME])).toMatchObject({
      kind: "linked",
      senderVerified: false,
    });
  });

  it("verifies a DKIM pass aligned with the From domain", () => {
    const signed = tagged({
      from: "Greenhouse <no-reply@greenhouse.io>",
      senderDomain: "greenhouse.io",
      authenticationResults: DKIM_GREENHOUSE,
    });
    expect(matchMail(signed, TAGS, [ACME])).toMatchObject({ kind: "linked", senderVerified: true });
  });

  it("doesn't match at step 3 on a DKIM pass that isn't aligned with From", () => {
    const unaligned = mail({
      senderDomain: "other.example.net",
      authenticationResults: "mx.google.com; dkim=pass header.d=acme.example.com",
    });
    expect(matchMail(unaligned, [], [ACME])).toMatchObject({ kind: "queued", reason: "no_match" });
  });

  it("never treats a shared ATS or freemail domain as a company's own", () => {
    const sloppy = app("app-x", { companyDomains: ["greenhouse.io", "gmail.com"] });
    const results = [
      matchMail(
        mail({ senderDomain: "greenhouse.io", authenticationResults: DKIM_GREENHOUSE }),
        [],
        [sloppy],
      ),
      matchMail(
        mail({
          senderDomain: "gmail.com",
          authenticationResults: "mx.google.com; dmarc=pass header.from=gmail.com",
        }),
        [],
        [sloppy],
      ),
    ];
    expect(results.map((r) => r.kind)).toEqual(["queued", "queued"]);
  });

  it("doesn't count a DKIM domain under a bare-suffix From as aligned", () => {
    const suffixFrom = tagged({
      senderDomain: "example.com",
      authenticationResults: "mx.google.com; dkim=pass header.d=acme.example.com",
    });
    expect(matchMail(suffixFrom, TAGS, [ACME])).toMatchObject({ senderVerified: false });
  });

  it("never treats a subdomain of a shared domain as a company's own", () => {
    const sloppy = app("app-x", { companyDomains: ["mail.greenhouse.io"] });
    const signed = mail({
      senderDomain: "mail.greenhouse.io",
      authenticationResults: "mx.google.com; dkim=pass header.d=mail.greenhouse.io",
    });
    expect(matchMail(signed, [], [sloppy])).toMatchObject({ kind: "queued", reason: "no_match" });
  });
});
