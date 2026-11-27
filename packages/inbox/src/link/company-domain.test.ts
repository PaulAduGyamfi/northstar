import { describe, expect, it } from "vitest";
import type { MessageHeaders } from "../gmail.js";
import { matchMail } from "./match.js";
import { toLinkCandidate } from "./step.js";

// Linking by sender with company domains Paul stored (NS-252, #313): only an authenticated
// sender under one of them links, and the wrong-domain cases never do. Synthetic mail only.

const AT = new Date("2026-11-25T12:00:00Z");
const ACME = "00000000-0000-4000-8000-0000000000a1";
const GLOBEX = "00000000-0000-4000-8000-0000000000a2";

const mail = (senderDomain: string, auth: string | null): MessageHeaders => ({
  id: "m1",
  threadId: "t1",
  from: `Recruiting <talent@${senderDomain}>`,
  senderDomain,
  subject: "Next steps for your application",
  deliveredTo: "candidate@example.com",
  authenticationResults: auth,
  receivedAt: AT,
  labelIds: ["INBOX"],
});
const dmarcPass = (domain: string) => `mx.google.com; dmarc=pass header.from=${domain}`;

// Rows as readLinkCandidates gives them, through toLinkCandidate.
const candidates = (acmeDomains: string[], globexDomains: string[] = []) => [
  toLinkCandidate(
    {
      applicationId: ACME,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      ats: ["greenhouse"],
      companyDomains: acmeDomains,
    },
    [],
  ),
  toLinkCandidate(
    {
      applicationId: GLOBEX,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      ats: [],
      companyDomains: globexDomains,
    },
    [],
  ),
];

const decide = (m: MessageHeaders, acme: string[], globex: string[] = []) =>
  matchMail(m, [], candidates(acme, globex));

describe("linking by a stored company domain", () => {
  it("passes the stored domains on to matching", () => {
    expect(candidates(["acme.example"])[0]?.companyDomains).toEqual(["acme.example"]);
  });

  it("links an authenticated sender under a stored domain, as verified", () => {
    expect(
      decide(mail("talent.acme.example", dmarcPass("talent.acme.example")), ["acme.example"]),
    ).toEqual({
      kind: "linked",
      applicationId: ACME,
      step: "sender",
      senderVerified: true,
    });
  });

  it("never links a sender that isn't authenticated", () => {
    expect(decide(mail("acme.example", null), ["acme.example"])).toEqual({
      kind: "queued",
      reason: "no_match",
      candidateIds: [],
    });
  });

  it("never links a lookalike domain", () => {
    for (const lookalike of ["acme-example.com", "acme.example.evil.example", "xacme.example"]) {
      expect(decide(mail(lookalike, dmarcPass(lookalike)), ["acme.example"]).kind).toBe("queued");
    }
  });

  it("ignores a stored freemail or shared ATS domain, so it never picks a company", () => {
    expect(decide(mail("gmail.com", dmarcPass("gmail.com")), ["gmail.com"]).kind).toBe("queued");
    expect(decide(mail("greenhouse.io", dmarcPass("greenhouse.io")), ["greenhouse.io"]).kind).toBe(
      "queued",
    );
  });

  it("queues a domain two companies were given rather than picking one", () => {
    expect(
      decide(
        mail("shared.example", dmarcPass("shared.example")),
        ["shared.example"],
        ["shared.example"],
      ),
    ).toEqual({ kind: "queued", reason: "ambiguous", candidateIds: [ACME, GLOBEX] });
  });
});
