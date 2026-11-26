import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { VerificationMessage, VerificationWindow, WindowSpec } from "./catcher.js";
import {
  type CloseReason,
  createStoredCatcher,
  type StoredCatcher,
  type StoredWindow,
  type WindowStore,
} from "./stored-catcher.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});

// Synthetic tenant and mail only (the repo is public). An in-memory store with the same
// contract as @northstar/db's dbWindowStore (whose races are tested on PGlite there).
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

const AUTH =
  "mx.google.com; dkim=pass header.d=myworkday.com; dmarc=pass header.from=myworkday.com";

function mail(over: Partial<VerificationMessage> = {}): VerificationMessage {
  return {
    messageId: "m-1",
    senderDomain: "myworkday.com",
    authenticationResults: AUTH,
    receivedAt: minutes(1),
    text: `Your verification code is ${CODE}.`,
    html: null,
    ...over,
  };
}

type Row = {
  base: VerificationWindow;
  ttlMs: number;
  restart: [Date, Date] | null;
  closed: CloseReason | null;
};

function memoryStore(): WindowStore & { rows: Map<string, Row>; used: Map<string, string> } {
  const rows = new Map<string, Row>();
  const used = new Map<string, string>();
  const view = (r: Row): StoredWindow => ({
    window: r.restart ? { ...r.base, openedAt: r.restart[0], expiresAt: r.restart[1] } : r.base,
    ttlMs: r.ttlMs,
    resent: r.restart !== null,
  });
  return {
    rows,
    used,
    insert: async (base, ttlMs) => {
      rows.set(base.id, { base, ttlMs, restart: null, closed: null });
    },
    openWindows: async () => [...rows.values()].filter((r) => r.closed === null).map(view),
    read: async (id) => {
      const r = rows.get(id);
      return r ? { ...view(r), closed: r.closed !== null } : null;
    },
    isUsed: async (id) => used.has(id),
    claim: async (messageId, windowId) => {
      if (used.has(messageId)) return false;
      used.set(messageId, windowId);
      return true;
    },
    restart: async (id, openedAt, expiresAt) => {
      const r = rows.get(id);
      if (!r || r.closed || r.restart) return false;
      r.restart = [openedAt, expiresAt];
      return true;
    },
    close: async (id, reason, _at, seenResent) => {
      const r = rows.get(id);
      if (!r || r.closed || (r.restart !== null) !== seenResent) return false;
      r.closed = reason;
      return true;
    },
  };
}

let clock: Date;
let store: ReturnType<typeof memoryStore>;
let catcher: StoredCatcher;
let ids: number;
beforeEach(() => {
  exporter.reset();
  clock = T0;
  ids = 0;
  store = memoryStore();
  catcher = createStoredCatcher({ store, now: () => clock, newId: () => `w-${++ids}` });
});

describe("createStoredCatcher", () => {
  it("stores the window it opens, with the same 10-minute default", async () => {
    const w = await catcher.open(SPEC);
    expect(await store.openWindows()).toEqual([{ window: w, ttlMs: 600_000, resent: false }]);
    expect(w.expiresAt.toISOString()).toBe("2026-11-25T12:10:00.000Z");
  });

  it("refuses the same allowlist entries as the in-memory catcher, storing nothing", async () => {
    await expect(catcher.open({ ...SPEC, senderDomains: ["*.myworkday.com"] })).rejects.toThrow(
      'a verification window\'s sender domains must be host names like "example.com"',
    );
    expect(store.rows.size).toBe(0);
  });

  it("hands out the code once and closes the window as verified", async () => {
    const w = await catcher.open(SPEC);
    const result = await catcher.offer(mail());
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect([result.kind, result.secret.reveal(), result.feedLine]).toEqual([
        "code",
        CODE,
        "Verified email for Acme (Workday)",
      ]);
    }
    expect(store.rows.get(w.id)?.closed).toBe("verified");
    expect(await catcher.offer(mail())).toEqual({ status: "not_verification" });
  });

  it("lets one email serve one window only, even after its window closed", async () => {
    await catcher.open(SPEC);
    await catcher.offer(mail());
    await catcher.open(SPEC);
    expect(await catcher.offer(mail())).toEqual({ status: "not_verification" });
  });

  it("gives a mail to neither of two matching windows, and claims nothing", async () => {
    await catcher.open(SPEC);
    await catcher.open(SPEC);
    expect(await catcher.offer(mail())).toEqual({ status: "ambiguous_window" });
    expect(store.used.size).toBe(0);
  });

  it("ignores a sender Gmail didn't authenticate, and mail from outside the window", async () => {
    await catcher.open(SPEC);
    const forged = mail({ authenticationResults: "evil.example.net; dmarc=pass" });
    const late = mail({ messageId: "m-2", receivedAt: minutes(11) });
    expect([await catcher.offer(forged), await catcher.offer(late)]).toEqual([
      { status: "not_verification" },
      { status: "not_verification" },
    ]);
  });

  it("keeps waiting after a mail with nothing to use", async () => {
    const w = await catcher.open(SPEC);
    expect(await catcher.offer(mail({ text: "Welcome to Acme careers!" }))).toEqual({
      status: "no_code_or_link",
      windowId: w.id,
    });
    expect(store.rows.get(w.id)?.closed).toBeNull();
  });

  it("hands a magic link to Paul when its host isn't the tenant's", async () => {
    await catcher.open(SPEC);
    const result = await catcher.offer(
      mail({ text: "Verify here: https://evil.example.net/verify?token=x" }),
    );
    expect(result).toMatchObject({
      status: "needs_human",
      reason: "link_host_not_allowed",
      feedLine: "Couldn't verify email for Acme (Workday): needs your hands",
    });
  });

  it("hands out a magic link on the tenant's host", async () => {
    await catcher.open(SPEC);
    const result = await catcher.offer(mail({ text: `Verify here: ${LINK}` }));
    expect(result.status === "verified" && result.secret.reveal()).toBe(LINK);
  });

  it("puts several codes to the pick, and hands Paul the step without one", async () => {
    const two = mail({ text: "Your code is 482913. Or use 771204." });
    await catcher.open(SPEC);
    const picked = await catcher.offerAssisted(two, async () => 1);
    expect(picked.status === "verified" && picked.secret.reveal()).toBe("771204");
    await catcher.open(SPEC);
    expect(await catcher.offer({ ...two, messageId: "m-2" })).toMatchObject({
      status: "needs_human",
      reason: "ambiguous_content",
    });
  });

  it("waits, resends once with a fresh window, then hands Paul the step", async () => {
    const w = await catcher.open(SPEC);
    clock = minutes(5);
    expect(await catcher.timeout(w.id)).toEqual({
      action: "wait",
      windowId: w.id,
      expiresAt: minutes(10),
    });
    clock = minutes(10);
    expect(await catcher.timeout(w.id)).toEqual({
      action: "resend",
      windowId: w.id,
      expiresAt: minutes(20),
    });
    clock = minutes(20);
    expect(await catcher.timeout(w.id)).toMatchObject({
      action: "needs_human",
      reason: "no_email",
      expected: { tenant: "Acme", ats: "Workday", purpose: "sign_up" },
    });
    expect(await catcher.timeout(w.id)).toEqual({ action: "closed", windowId: w.id });
  });

  it("matches the resent window's new times, not the first ones", async () => {
    const w = await catcher.open(SPEC);
    clock = minutes(10);
    await catcher.timeout(w.id);
    // A late first email (with the code the resend voided) arrives before the restart.
    expect(await catcher.offer(mail({ receivedAt: minutes(9) }))).toEqual({
      status: "not_verification",
    });
    const fresh = await catcher.offer(mail({ messageId: "m-2", receivedAt: minutes(12) }));
    expect(fresh.status).toBe("verified");
  });

  it("hands nothing out when another process closed the window first", async () => {
    const w = await catcher.open(SPEC);
    // The other process closes it between this call's claim and its close.
    const claim = store.claim;
    store.claim = async (...args) => {
      const won = await claim(...args);
      await store.close(w.id, "no_email", clock, false);
      return won;
    };
    expect(await catcher.offer(mail())).toEqual({ status: "not_verification" });
  });

  it("hands nothing out when the window was resent while the pick ran", async () => {
    const w = await catcher.open(SPEC);
    const two = mail({ text: "Your code is 482913. Or use 771204." });
    const result = await catcher.offerAssisted(two, async () => {
      clock = minutes(10);
      await catcher.timeout(w.id);
      return 0;
    });
    expect(result).toEqual({ status: "not_verification" });
    expect(store.rows.get(w.id)?.closed).toBeNull();
  });

  it("reads another process's resend instead of resending twice", async () => {
    const w = await catcher.open(SPEC);
    clock = minutes(10);
    await store.restart(w.id, minutes(10), minutes(20));
    expect(await catcher.timeout(w.id)).toEqual({
      action: "wait",
      windowId: w.id,
      expiresAt: minutes(20),
    });
  });

  it("flags a pick that threw on its span, and hands Paul the step", async () => {
    await catcher.open(SPEC);
    const two = mail({ text: "Your code is 482913. Or use 771204." });
    const result = await catcher.offerAssisted(two, async () => {
      throw new Error("model down");
    });
    expect(result).toMatchObject({ status: "needs_human", reason: "ambiguous_content" });
    const span = exporter.getFinishedSpans().find((s) => s.name === "verification.catch");
    expect(span?.attributes).toMatchObject({
      "verification.outcome": "ambiguous_content",
      "verification.assisted": true,
      "verification.pick_error": true,
    });
  });

  it("refuses a tenant that isn't a plain label, storing nothing", async () => {
    await expect(catcher.open({ ...SPEC, tenant: "Acme, Inc." })).rejects.toThrow(
      'a stored verification window\'s tenant must be a plain label like "Acme"',
    );
    expect(store.rows.size).toBe(0);
  });

  it("records ids and outcomes on its spans, never the code", async () => {
    await catcher.open(SPEC);
    await catcher.offer(mail());
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "verification.catch");
    expect(spans.map((s) => s.attributes["verification.outcome"])).toEqual(["verified"]);
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain(CODE);
  });
});
