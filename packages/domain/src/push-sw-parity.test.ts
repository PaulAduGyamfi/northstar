import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { APPLY_ATS } from "./apply-package.js";
import { PUSH_CHALLENGES, pushWords } from "./push-payload.js";

// The service worker (apps/web/public/sw.js, NS-193 slice 2) keeps its own copy of pushWords: it
// is plain JavaScript the browser loads, with no build step. Run its `words` in a sandbox and
// check it says exactly what pushWords says, and nothing a push sends as text.

const SW = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/sw.js");

type Words = { title: string; body: string; tag: string };
function serviceWorkerWords(): (data: unknown) => Words {
  const context = createContext({
    self: { addEventListener: () => undefined },
    URL,
  });
  runInContext(readFileSync(SW, "utf8"), context);
  return context.words as (data: unknown) => Words;
}

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
