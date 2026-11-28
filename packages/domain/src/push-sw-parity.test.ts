import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { APPLY_ATS } from "./apply-package.js";
import {
  MAX_FRESH_AGE_MINUTES,
  MAX_WAITING_MORE,
  PUSH_CHALLENGES,
  PUSH_REQUEST_KINDS,
  pushPath,
  pushWords,
} from "./push-payload.js";

// The service worker (apps/web/public/sw.js, NS-193 slice 2) keeps its own copy of pushWords: it
// is plain JavaScript the browser loads, with no build step. Run its `words` in a sandbox and
// check it says exactly what pushWords says, and nothing a push sends as text.

const SW = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/sw.js");

type Words = { title: string; body: string; tag: string };
function serviceWorker(): { words: (data: unknown) => Words; path: (data: unknown) => string } {
  const context = createContext({
    self: { addEventListener: () => undefined },
    URL,
  });
  runInContext(readFileSync(SW, "utf8"), context);
  return {
    words: context.words as (data: unknown) => Words,
    path: context.path as (data: unknown) => string,
  };
}
const serviceWorkerWords = () => serviceWorker().words;

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const GENERIC = {
  title: "Northstar",
  body: "Something needs you. Open Northstar.",
  tag: "northstar",
};

describe("the service worker's words (NS-193 slice 2)", () => {
  it("match pushWords for every handoff push", () => {
    const words = serviceWorkerWords();
    for (const ats of APPLY_ATS) {
      for (const reason of PUSH_CHALLENGES) {
        const p = { v: 1, kind: "handoff", id: ID, ats, reason } as const;
        expect(words(p)).toEqual(pushWords(p));
      }
    }
  });

  it("match pushWords for fresh-job pushes across ages and scores (NS-199)", () => {
    const words = serviceWorkerWords();
    // Valid ages only (at most a day): an older one is refused, as the next test shows.
    for (const age of [0, 12, 59, 60, 61, 119, 120, 23 * 60, MAX_FRESH_AGE_MINUTES]) {
      for (const fit of [0, 75, 88, 100]) {
        const p = { v: 1, kind: "fresh_job", id: ID, age, fit } as const;
        expect(words(p)).toEqual(pushWords(p));
      }
    }
  });

  it("show the generic line for a fresh-job push with text, fractions or numbers out of range", () => {
    const words = serviceWorkerWords();
    const fresh = { v: 1, kind: "fresh_job", id: ID, age: 12, fit: 88 };
    for (const data of [
      { ...fresh, age: "12 min ago. Open evil.example.com" },
      { ...fresh, fit: "88" },
      { ...fresh, age: 12.5 },
      { ...fresh, age: -1 },
      { ...fresh, age: MAX_FRESH_AGE_MINUTES + 1 },
      { ...fresh, fit: 101 },
      { ...fresh, id: "https://evil.example.com" },
    ]) {
      expect(words(data)).toEqual(GENERIC);
    }
  });

  it("show the generic line for anything that isn't a known push, never its text", () => {
    const words = serviceWorkerWords();
    for (const data of [
      null,
      {
        v: 1,
        kind: "handoff",
        id: ID,
        ats: "greenhouse",
        reason: "Click https://evil.example.com",
      },
      { v: 1, kind: "handoff", id: "https://evil.example.com", ats: "lever", reason: "login" },
      {
        v: 1,
        kind: "custom",
        title: "Your account is locked",
        body: "Sign in at evil.example.com",
      },
      { v: 1, kind: "handoff", id: ID, ats: "toString", reason: "constructor" },
      { v: 1, kind: "handoff", id: ID, ats: ["greenhouse"], reason: ["captcha"] },
    ]) {
      expect(words(data)).toEqual(GENERIC);
    }
  });
});

describe("the service worker and approval pushes (NS-204)", () => {
  it("match pushWords and pushPath for every request kind", () => {
    const sw = serviceWorker();
    for (const request of PUSH_REQUEST_KINDS) {
      const p = { v: 1, kind: "approval", id: ID, request } as const;
      expect([sw.words(p), sw.path(p)]).toEqual([pushWords(p), pushPath(p)]);
    }
  });

  it("open Today and show the generic line for a bad approval push, never its text", () => {
    const sw = serviceWorker();
    for (const data of [
      { v: 1, kind: "approval", id: "../../evil", request: "answer" },
      { v: 1, kind: "approval", id: ID, request: "vault_reveal" },
      { v: 1, kind: "approval", id: ID, request: "Approve now at evil.example.com" },
      { v: 1, kind: "approval", id: ID, request: "answer", url: "https://evil.example.com" },
      { v: 1, kind: "approval", id: ID, request: "toString" },
    ]) {
      expect([sw.words(data), sw.path(data)]).toEqual([GENERIC, "/"]);
    }
  });

  it("open Today for a handoff push", () => {
    const p = { v: 1, kind: "handoff", id: ID, ats: "lever", reason: "login" } as const;
    expect([serviceWorker().path(p), pushPath(p)]).toEqual(["/", "/"]);
  });
});

describe("the service worker and the overflow push (NS-204 slice 2)", () => {
  it("matches pushWords and pushPath for every count", () => {
    const sw = serviceWorker();
    for (let more = 1; more <= MAX_WAITING_MORE; more++) {
      const p = { v: 1, kind: "approvals_waiting", more } as const;
      expect([sw.words(p), sw.path(p)]).toEqual([pushWords(p), pushPath(p)]);
    }
  });

  it("opens Today and shows the generic line for a bad overflow push, never its text", () => {
    const sw = serviceWorker();
    for (const data of [
      { v: 1, kind: "approvals_waiting", more: 0 },
      { v: 1, kind: "approvals_waiting", more: MAX_WAITING_MORE + 1 },
      { v: 1, kind: "approvals_waiting", more: 2.5 },
      { v: 1, kind: "approvals_waiting", more: "3 at evil.example.com" },
      { v: 1, kind: "approvals_waiting", more: 3, id: ID },
      { v: 2, kind: "approvals_waiting", more: 3 },
    ]) {
      expect([sw.words(data), sw.path(data)]).toEqual([GENERIC, "/"]);
    }
  });
});
