import { describe, expect, it } from "vitest";
import { classifyByRules } from "./classify-rules.js";
import {
  authenticatedDomains,
  backfillQuery,
  isAuthenticatedSender,
  isHostName,
  isJobMail,
} from "./prefilter.js";

// Synthetic headers only (the repo is public). The domains are the real ATS vendors' sending
// domains, which are public facts, not anyone's personal data.
const h = (senderDomain: string, subject: string, authenticationResults: string | null = null) => ({
  senderDomain,
  subject,
  authenticationResults,
});

describe("isJobMail", () => {
  it("keeps mail from a known ATS domain, including subdomains, when Gmail verified the sender", () => {
    const verified = (d: string) => `mx.google.com; dmarc=pass header.from=${d}`;
    expect(
      isJobMail(h("us.greenhouse-mail.io", "Hello", verified("greenhouse-mail.io")), new Set()),
    ).toBe(true);
    expect(
      isJobMail(
        h("hire.lever.co", "Update", "mx.google.com; dkim=pass header.d=lever.co"),
        new Set(),
      ),
    ).toBe(true);
  });

  it("doesn't trust a forged ATS sender: no DMARC or DKIM pass for that domain", () => {
    expect(isJobMail(h("myworkday.com", "Update", null), new Set())).toBe(false);
    expect(
      isJobMail(
        h("myworkday.com", "Update", "mx.google.com; dmarc=fail header.from=myworkday.com"),
        new Set(),
      ),
    ).toBe(false);
    expect(
      isJobMail(
        h("myworkday.com", "Update", "mx.google.com; dmarc=pass header.from=evil.example"),
        new Set(),
      ),
    ).toBe(false);
  });

  it("keeps mail whose subject is a job-specific phrase", () => {
    expect(isJobMail(h("globex.example", "Thank you for applying to Globex"), new Set())).toBe(
      true,
    );
    expect(
      isJobMail(h("globex.example", "Interview invitation: Backend Engineer"), new Set()),
    ).toBe(true);
    expect(isJobMail(h("globex.example", "Your candidacy"), new Set())).toBe(true);
  });

  it("doesn't keep a generic phrase on its own: a mortgage or visa email isn't job mail", () => {
    expect(
      isJobMail(h("bank.example", "Next steps for your mortgage application"), new Set()),
    ).toBe(false);
    expect(isJobMail(h("visa.example", "Your application status"), new Set())).toBe(false);
    expect(isJobMail(h("press.example", "Interview request from a podcast"), new Set())).toBe(
      false,
    );
  });

  it("keeps mail from a domain already on a funnel message", () => {
    expect(isJobMail(h("globex.example", "Quick question"), new Set(["globex.example"]))).toBe(
      true,
    );
  });

  it("drops newsletters and promotions, even ones that say offer or opportunity", () => {
    expect(isJobMail(h("shop.example", "Special offer: 20% off"), new Set())).toBe(false);
    expect(isJobMail(h("news.example", "A new opportunity to save"), new Set())).toBe(false);
    expect(isJobMail(h("friend.example", "Dinner on Friday?"), new Set())).toBe(false);
  });

  it("doesn't let a look-alike domain pass as an ATS", () => {
    const pass = (d: string) => `mx.google.com; dmarc=pass header.from=${d}`;
    expect(
      isJobMail(
        h("greenhouse.io.evil.example", "Hi", pass("greenhouse.io.evil.example")),
        new Set(),
      ),
    ).toBe(false);
    expect(isJobMail(h("notlever.co", "Hi", pass("notlever.co")), new Set())).toBe(false);
  });
});

describe("authenticatedDomains", () => {
  it("reads DMARC header.from and DKIM header.d or header.i, passes only", () => {
    expect(
      authenticatedDomains(
        "mx.google.com; dkim=pass header.i=@mail.globex.example; spf=pass; dmarc=pass header.from=globex.example; dkim=fail header.d=evil.example",
      ),
    ).toEqual(["mail.globex.example", "globex.example"]);
    expect(authenticatedDomains(null)).toEqual([]);
  });

  it("reads a Gmail-style header whose results carry comments", () => {
    expect(
      authenticatedDomains(
        "mx.google.com; dkim=pass (test mode) header.i=@globex.example header.s=s1 header.b=AbC1; spf=pass (google.com: domain of jobs@globex.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=jobs@globex.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=globex.example",
      ),
    ).toEqual(["globex.example", "globex.example"]);
  });

  it("doesn't trust a pass the sender wrote into its own envelope address", () => {
    // The attacker picks the envelope sender; Gmail copies it into the SPF comment and
    // smtp.mailfrom. Only a result whose method comes first, with its own header.* token, counts.
    expect(
      authenticatedDomains(
        "mx.google.com; dkim=none; spf=pass (google.com: domain of dkim=pass.header.d=myworkday.com@evil.example designates 192.0.2.9 as permitted sender) smtp.mailfrom=dkim=pass.header.d=myworkday.com@evil.example; dmarc=fail (p=NONE) header.from=myworkday.com",
      ),
    ).toEqual([]);
  });

  it("reads nothing from a header with a quoted envelope address, which could hide a fake result", () => {
    expect(
      authenticatedDomains(
        'mx.google.com; spf=pass smtp.mailfrom="x;dkim=pass header.d=myworkday.com"@evil.example; dmarc=fail header.from=myworkday.com',
      ),
    ).toEqual([]);
  });

  it("reads nothing from a header that another server wrote, even a look-alike of Gmail's (NS-217)", () => {
    const pass = "; dmarc=pass header.from=globex.example; dkim=pass header.d=globex.example";
    expect(
      ["mx.example.com", "mx.google.com.evil.example", "relay.mx.google.com", ""].map((id) =>
        authenticatedDomains(`${id}${pass}`),
      ),
    ).toEqual([[], [], [], []]);
  });

  it("reads nothing from a header with unbalanced comment parentheses", () => {
    expect(
      authenticatedDomains(
        "mx.google.com; spf=pass (unclosed; dmarc=pass header.from=myworkday.com",
      ),
    ).toEqual([]);
  });
});

describe("isAuthenticatedSender (NS-160)", () => {
  const results = (domain: string) => `mx.google.com; dmarc=pass header.from=${domain}`;

  it("doesn't trust a sender verified only by a header another server wrote (NS-217)", () => {
    expect(
      isAuthenticatedSender({
        senderDomain: "globex.example",
        authenticationResults: "mx.example.com; dmarc=pass header.from=globex.example",
      }),
    ).toBe(false);
  });

  it("trusts a host-name-shaped sender domain the results header verified", () => {
    expect(
      isAuthenticatedSender({
        senderDomain: "ats.example.com",
        authenticationResults: results("ats.example.com"),
      }),
    ).toBe(true);
  });

  it("refuses a sender domain that isn't shaped like a host name", () => {
    const bad = ["ats..example.com", "localhost", "-ats.example.com"];
    expect(
      bad.map((d) => isAuthenticatedSender({ senderDomain: d, authenticationResults: results(d) })),
    ).toEqual(bad.map(() => false));
  });

  it("refuses a space, slash or underscore under a verified parent domain", () => {
    const bad = ["x y.example.com", "x/y.example.com", "x_y.example.com"];
    expect(
      bad.map((d) =>
        isAuthenticatedSender({ senderDomain: d, authenticationResults: results("example.com") }),
      ),
    ).toEqual([false, false, false]);
  });
});

describe("isHostName", () => {
  it("accepts dotted labels of letters, digits and inner hyphens only", () => {
    expect(
      ["example.com", "a-b.example.co.uk", "x".repeat(254), "example-.com", "example"].map(
        isHostName,
      ),
    ).toEqual([true, true, false, false, false]);
  });
});

describe("backfillQuery", () => {
  it("starts at the given day and ORs the ATS senders and job phrases", () => {
    const q = backfillQuery("2026-02-01");
    expect(q.startsWith("after:2026/02/01 {")).toBe(true);
    expect(q).toContain("from:greenhouse-mail.io");
    expect(q).toContain('subject:"thank you for applying"');
  });
});

describe("classifyByRules", () => {
  it("reads company and role from a standard confirmation subject", () => {
    expect(
      classifyByRules({
        subject: "Thank you for applying for the Backend Engineer role at Globex",
      }),
    ).toEqual({ kind: "confirmation", company: "Globex", role: "Backend Engineer" });
  });

  it("reads the company when the subject names no role", () => {
    expect(classifyByRules({ subject: "Thanks for applying to Initech!" })).toEqual({
      kind: "confirmation",
      company: "Initech",
      role: null,
    });
    expect(classifyByRules({ subject: "Your application to Acme Corp has been received" })).toEqual(
      {
        kind: "confirmation",
        company: "Acme Corp",
        role: null,
      },
    );
  });

  it("leaves everything else to the model", () => {
    expect(classifyByRules({ subject: "We received your application" })).toBeNull();
    expect(classifyByRules({ subject: "Update on your application to Globex" })).toBeNull();
    expect(classifyByRules({ subject: "Interview invitation" })).toBeNull();
  });
});
