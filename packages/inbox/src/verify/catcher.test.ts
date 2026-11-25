import { inspect } from "node:util";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Catcher,
  createCatcher,
  MAX_BODY_CHARS,
  type VerificationMessage,
  type WindowSpec,
} from "./catcher.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

// Synthetic tenant and mail only (the repo is public).
const T0 = new Date("2026-11-25T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const CODE = "482913";
const LINK = "https://acme.wd5.myworkdayjobs.com/verify?token=tok-123";

const SPEC: WindowSpec = {
  tenant: "Acme",
  ats: "Workday",
  purpose: "sign_up",
  senderDomains: ["myworkday.com"],
  linkHosts: ["acme.wd5.myworkdayjobs.com"],
};

const verified = (d: string) =>
  `mx.google.com; dkim=pass header.d=${d}; dmarc=pass header.from=${d}`;

function mail(over: Partial<VerificationMessage> = {}): VerificationMessage {
  return {
    messageId: "m-1",
    senderDomain: "myworkday.com",
    authenticationResults: verified("myworkday.com"),
    receivedAt: minutes(1),
    text: `Your verification code is ${CODE}.`,
    html: null,
    ...over,
  };
}

let clock: Date;
let catcher: Catcher;
let ids: number;
beforeEach(() => {
  exporter.reset();
  clock = T0;
  ids = 0;
  catcher = createCatcher({ now: () => clock, newId: () => `w-${++ids}` });
});

describe("open", () => {
  it("opens a 10-minute window by default", () => {
    const w = catcher.open(SPEC);
    expect([w.id, w.openedAt.toISOString(), w.expiresAt.toISOString()]).toEqual([
      "w-1",
      "2026-11-25T12:00:00.000Z",
      "2026-11-25T12:10:00.000Z",
    ]);
  });

  it("never opens a window longer than 30 minutes", () => {
    const w = catcher.open({ ...SPEC, ttlMs: 3 * 60 * 60_000 });
    expect(w.expiresAt.toISOString()).toBe("2026-11-25T12:30:00.000Z");
  });

  it("refuses allowlist entries that would allow far more than one tenant", () => {
    for (const bad of ["com", "", ".myworkday.com", "*.myworkday.com", "203.0.113.7"]) {
      expect(() => catcher.open({ ...SPEC, senderDomains: [bad] })).toThrow(
        'a verification window\'s sender domains must be host names like "example.com"',
      );
      expect(() => catcher.open({ ...SPEC, linkHosts: [bad] })).toThrow(
        'a verification window\'s link hosts must be host names like "example.com"',
      );
    }
  });

  it("refuses a window with no sender domain, since it could never match safely", () => {
    expect(() => catcher.open({ ...SPEC, senderDomains: [] })).toThrow(
      "a verification window needs at least one sender domain",
    );
  });
});

describe("offer: routing (VER-002)", () => {
  it("returns the code from an authenticated sender inside the window", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail());
    expect(r.status === "verified" && [r.windowId, r.kind, r.secret.reveal(), r.feedLine]).toEqual([
      "w-1",
      "code",
      CODE,
      "Verified email for Acme (Workday)",
    ]);
  });

  it("accepts a sender on a subdomain of an allowed domain", () => {
    catcher.open(SPEC);
    const r = catcher.offer(
      mail({
        senderDomain: "mail.myworkday.com",
        authenticationResults: verified("myworkday.com"),
      }),
    );
    expect(r.status).toBe("verified");
  });

  it("ignores a forged sender that Gmail didn't authenticate", () => {
    catcher.open(SPEC);
    expect(catcher.offer(mail({ authenticationResults: null })).status).toBe("not_verification");
    expect(
      catcher.offer(mail({ messageId: "m-2", authenticationResults: verified("evil.example") }))
        .status,
    ).toBe("not_verification");
  });

  it("ignores a pass in a header that Gmail didn't write", () => {
    catcher.open(SPEC);
    const r = catcher.offer(
      mail({ authenticationResults: "relay.evil.example; dmarc=pass header.from=myworkday.com" }),
    );
    expect(r.status).toBe("not_verification");
  });

  it("ignores a sender that wrote a pass into its own envelope address", () => {
    catcher.open(SPEC);
    const r = catcher.offer(
      mail({
        authenticationResults:
          "mx.google.com; dkim=none; spf=pass (google.com: domain of dkim=pass.header.d=myworkday.com@evil.example designates 192.0.2.9 as permitted sender) smtp.mailfrom=dkim=pass.header.d=myworkday.com@evil.example; dmarc=fail (p=NONE) header.from=myworkday.com",
      }),
    );
    expect(r.status).toBe("not_verification");
  });

  it("ignores an authenticated sender that isn't on the window's list", () => {
    catcher.open(SPEC);
    const r = catcher.offer(
      mail({ senderDomain: "evil.example", authenticationResults: verified("evil.example") }),
    );
    expect(r.status).toBe("not_verification");
  });

  it("ignores mail that arrived before the window opened or after it closed", () => {
    catcher.open(SPEC);
    expect(catcher.offer(mail({ receivedAt: minutes(-1) })).status).toBe("not_verification");
    expect(catcher.offer(mail({ messageId: "m-2", receivedAt: minutes(11) })).status).toBe(
      "not_verification",
    );
  });

  it("uses a window once: a second email after a verified one matches nothing", () => {
    catcher.open(SPEC);
    expect(catcher.offer(mail()).status).toBe("verified");
    expect(catcher.offer(mail({ messageId: "m-2" })).status).toBe("not_verification");
  });

  it("uses a message once: offering the same message to a new window matches nothing", () => {
    catcher.open(SPEC);
    expect(catcher.offer(mail()).status).toBe("verified");
    catcher.open(SPEC);
    expect(catcher.offer(mail()).status).toBe("not_verification");
  });

  it("uses neither window when two open windows match the same message", () => {
    catcher.open(SPEC);
    catcher.open({ ...SPEC, tenant: "Globex" });
    expect(catcher.offer(mail()).status).toBe("ambiguous_window");
    // Both stay open: a later timeout still treats each one on its own.
    clock = minutes(10);
    expect([catcher.timeout("w-1").action, catcher.timeout("w-2").action]).toEqual([
      "resend",
      "resend",
    ]);
  });
});

describe("offer: content (VER-003, VER-004)", () => {
  it("returns the link when the mail has a safe verification link and no code", () => {
    catcher.open(SPEC);
    const html = `<p>Welcome!</p><a href="${LINK.replace("&", "&amp;")}">Verify your email</a>`;
    const r = catcher.offer(mail({ text: "", html }));
    expect(r.status === "verified" && [r.kind, r.secret.reveal()]).toEqual(["link", LINK]);
  });

  it("returns the link in the parsed form it was checked in", () => {
    catcher.open(SPEC);
    const r = catcher.offer(
      mail({ text: "Verify: https://ACME.wd5.myworkdayjobs.com:443/verify?token=tok-123" }),
    );
    expect(r.status === "verified" && r.secret.reveal()).toBe(LINK);
  });

  it("raises needs_human for a link with a backslash, which parsers read differently", () => {
    catcher.open(SPEC);
    const html = '<a href="https://acme.wd5.myworkdayjobs.com\\@evil.example/verify">Verify</a>';
    const r = catcher.offer(mail({ text: "", html }));
    expect(r.status === "needs_human" && [r.reason, r.refusal]).toEqual([
      "link_host_not_allowed",
      "unsafe_characters",
    ]);
  });

  it("raises needs_human without scanning a body over the size limit", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail({ html: `<p>${"x".repeat(MAX_BODY_CHARS)}</p>` }));
    expect(r.status === "needs_human" && r.reason).toBe("message_too_large");
  });

  it("prefers the code when the mail carries a code and a link", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail({ text: `Your code is ${CODE}. Or verify here: ${LINK}` }));
    expect(r.status === "verified" && [r.kind, r.secret.reveal()]).toEqual(["code", CODE]);
  });

  it("raises needs_human and closes the window for a link to a host off the allowlist", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail({ text: "Verify: https://evil.example/verify/abc" }));
    expect(r.status === "needs_human" && [r.reason, r.feedLine]).toEqual([
      "link_host_not_allowed",
      "Couldn't verify email for Acme (Workday): needs your hands",
    ]);
    expect(catcher.offer(mail({ messageId: "m-2" })).status).toBe("not_verification");
  });

  it("raises needs_human for an http link even on an allowed host", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail({ text: "Verify: http://acme.wd5.myworkdayjobs.com/verify/abc" }));
    expect(r.status === "needs_human" && r.reason).toBe("link_host_not_allowed");
  });

  it("raises needs_human rather than guess when the mail has two different codes", () => {
    catcher.open(SPEC);
    const r = catcher.offer(mail({ text: "Your code is 482913.\nYour old code 111222 expired." }));
    expect(r.status === "needs_human" && r.reason).toBe("ambiguous_content");
  });

  it("raises needs_human rather than guess when the mail has two verification links", () => {
    catcher.open(SPEC);
    const text = `Verify: ${LINK}\nOr confirm: https://acme.wd5.myworkdayjobs.com/confirm/other`;
    const r = catcher.offer(mail({ text }));
    expect(r.status === "needs_human" && r.reason).toBe("ambiguous_content");
  });

  it("keeps the window open after a mail from the sender with no code or link", () => {
    catcher.open(SPEC);
    const welcome = catcher.offer(mail({ text: "Welcome to Acme careers!" }));
    expect(welcome.status === "no_code_or_link" && welcome.windowId).toBe("w-1");
    expect(catcher.offer(mail({ messageId: "m-2" })).status).toBe("verified");
  });
});

describe("timeout (VER-006)", () => {
  it("waits while the window is still open", () => {
    catcher.open(SPEC);
    clock = minutes(5);
    expect(catcher.timeout("w-1")).toEqual({
      action: "wait",
      windowId: "w-1",
      expiresAt: minutes(10),
    });
  });

  it("asks for one resend first, reopening the window for another full period", () => {
    catcher.open(SPEC);
    clock = minutes(10);
    expect(catcher.timeout("w-1")).toEqual({
      action: "resend",
      windowId: "w-1",
      expiresAt: minutes(20),
    });
    expect(catcher.offer(mail({ receivedAt: minutes(15) })).status).toBe("verified");
  });

  it("after a resend, ignores a late first email, whose code the ATS may have voided", () => {
    catcher.open(SPEC);
    clock = minutes(10);
    catcher.timeout("w-1");
    expect(catcher.offer(mail({ receivedAt: minutes(9) })).status).toBe("not_verification");
  });

  it("raises needs_human with what was expected when the resend brings nothing either", () => {
    catcher.open(SPEC);
    clock = minutes(10);
    catcher.timeout("w-1");
    clock = minutes(20);
    expect(catcher.timeout("w-1")).toEqual({
      action: "needs_human",
      windowId: "w-1",
      reason: "no_email",
      expected: {
        tenant: "Acme",
        ats: "Workday",
        purpose: "sign_up",
        senderDomains: ["myworkday.com"],
      },
      feedLine: "Couldn't verify email for Acme (Workday): needs your hands",
    });
    expect(catcher.offer(mail({ receivedAt: minutes(19) })).status).toBe("not_verification");
  });

  it("does nothing for a window that is already closed or unknown", () => {
    catcher.open(SPEC);
    catcher.offer(mail());
    expect(catcher.timeout("w-1")).toEqual({ action: "closed", windowId: "w-1" });
    expect(catcher.timeout("w-9")).toEqual({ action: "closed", windowId: "w-9" });
  });
});

describe("secrets stay out of logs and spans (VER-005)", () => {
  it("prints no code or link when a result is serialized, stringified or inspected", () => {
    catcher.open(SPEC);
    const code = catcher.offer(mail());
    catcher.open(SPEC);
    const link = catcher.offer(mail({ messageId: "m-2", text: `Verify: ${LINK}` }));
    for (const r of [code, link]) {
      const printed = [JSON.stringify(r), String(Object.values(r)), inspect(r, { depth: 9 })];
      expect(printed.filter((p) => p.includes(CODE) || p.includes("tok-123"))).toEqual([]);
    }
  });

  it("records a span per matched offer with ids and outcome but no code, link or sender", () => {
    catcher.open(SPEC);
    catcher.offer(mail());
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => [s.name, s.attributes])).toEqual([
      [
        "verification.catch",
        {
          "verification.window_id": "w-1",
          "verification.tenant": "Acme",
          "verification.ats": "Workday",
          "verification.purpose": "sign_up",
          "verification.kind": "code",
          "verification.outcome": "verified",
        },
      ],
    ]);
  });

  it("records a refused link's span with no part of the link", () => {
    catcher.open(SPEC);
    catcher.offer(mail({ text: "Verify: https://evil.example/verify/tok-123" }));
    const attrs = exporter.getFinishedSpans().map((s) => s.attributes);
    expect(attrs).toEqual([
      {
        "verification.window_id": "w-1",
        "verification.tenant": "Acme",
        "verification.ats": "Workday",
        "verification.purpose": "sign_up",
        "verification.kind": "link",
        "verification.outcome": "link_host_not_allowed",
      },
    ]);
  });

  it("records a span on each window a message matched ambiguously", () => {
    catcher.open(SPEC);
    catcher.open({ ...SPEC, tenant: "Globex" });
    catcher.offer(mail());
    expect(
      exporter
        .getFinishedSpans()
        .map((s) => [s.attributes["verification.window_id"], s.attributes["verification.outcome"]]),
    ).toEqual([
      ["w-1", "ambiguous_window"],
      ["w-2", "ambiguous_window"],
    ]);
  });

  it("records a span for each timeout decision", () => {
    catcher.open(SPEC);
    clock = minutes(10);
    catcher.timeout("w-1");
    expect(exporter.getFinishedSpans().map((s) => s.attributes["verification.outcome"])).toEqual([
      "resend",
    ]);
  });
});
