import type { UnclassifiedMail } from "@northstar/db";
import { type FullMessage, GmailError, type RecruiterExtractResult } from "@northstar/inbox";
import { HeldBack, LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import {
  type GradeLetterReason,
  type GradingDeps,
  MAX_GRADE,
  runGrading,
  type StoredGrade,
} from "./grade.js";

// Grading recruiter mail in `funnel inbox` (NS-238 item 1 slice 2) with every port faked: no
// Gmail, model or database. Invented ids and synthetic text only.

const id = (n: number) => `18c3f0a2b4d6e${String(n).padStart(3, "0")}`;
const row = (n: number): UnclassifiedMail => ({
  mailLinkId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  gmailMessageId: id(n),
});
const mail = (gmailId: string): FullMessage =>
  ({
    id: gmailId,
    body: `Hi, a Senior Engineer role at Initech (${gmailId}).`,
  }) as unknown as FullMessage;

const RECORD = { promptVersion: 1, modelServed: "claude-opus-5-5" } as unknown as Extract<
  RecruiterExtractResult,
  { kind: "extracted" }
>["record"];

const FACTS = {
  roleTitle: "Senior Engineer",
  seniority: null,
  company: "Initech",
  location: null,
  remote: "remote",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  agency: false,
  personalizedQuote: null,
  redFlags: [],
} as Extract<RecruiterExtractResult, { kind: "extracted" }>["facts"];

const EXTRACTED: RecruiterExtractResult = {
  kind: "extracted",
  facts: FACTS,
  dropped: [],
  record: RECORD,
};
const GRADE: StoredGrade = {
  grade: "B",
  points: 4,
  reasons: ["title:exact"],
  confidence: "normal",
};

function fake(over: Partial<GradingDeps> = {}) {
  const letters: { id: string; reason: GradeLetterReason; key: string }[] = [];
  const saved: { id: string; grade: StoredGrade }[] = [];
  const extracted: string[] = [];
  const deps: GradingDeps = {
    enabled: true,
    gradeLetters: async () => [],
    ungraded: async () => [row(1)],
    readFull: async (gmailId) => mail(gmailId),
    extract: async (body) => {
      extracted.push(body);
      return EXTRACTED;
    },
    grade: async () => GRADE,
    record: async (gmailId, grade) => {
      saved.push({ id: gmailId, grade });
      return { ok: true };
    },
    recordGradeLetter: async (m, reason, key) => {
      letters.push({ id: m.gmailMessageId, reason, key });
    },
    ...over,
  };
  return { deps, letters, saved, extracted };
}

describe("runGrading", () => {
  it("reads and sends nothing while recruiter reading is off", async () => {
    let read = false;
    const f = fake({
      enabled: false,
      ungraded: async () => {
        read = true;
        return [row(1)];
      },
    });
    const r = await runGrading(f.deps);
    expect([r.enabled, r.graded, read, f.extracted]).toEqual([false, 0, false, []]);
  });

  it("grades a recruiter email from its body and stores the grader's own grade", async () => {
    const f = fake();
    const r = await runGrading(f.deps);
    expect([r.graded, f.extracted, f.saved]).toEqual([
      1,
      [mail(id(1)).body],
      [{ id: id(1), grade: GRADE }],
    ]);
  });

  it("grades at most ten a run, passing over lettered messages, and says more wait", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
    let asked = 0;
    const f = fake({
      gradeLetters: async () => [{ idempotencyKey: `mail.grade:${id(1)}:1`, action: "skip" }],
      ungraded: async (limit) => {
        asked = limit;
        return rows.slice(0, limit);
      },
    });
    const r = await runGrading(f.deps);
    expect([asked, f.saved.length, f.saved[0]?.id, r.moreToGrade]).toEqual([
      MAX_GRADE + 2,
      MAX_GRADE,
      id(2),
      true,
    ]);
  });

  it("letters each failure kind and carries on with the next email", async () => {
    const results: RecruiterExtractResult[] = [
      { kind: "needs_human", reason: "refused", record: RECORD },
      EXTRACTED,
      EXTRACTED,
    ];
    const f = fake({
      ungraded: async () => [row(1), row(2), row(3), row(4)],
      readFull: async (gmailId) => {
        if (gmailId === id(1)) throw new GmailError("Gmail answered 404", 404);
        return mail(gmailId);
      },
      extract: async () => results.shift() as RecruiterExtractResult,
      grade: async () => {
        if (results.length === 1) throw new TypeError("bad");
        return GRADE;
      },
      record: async () => ({ ok: false }),
    });
    const r = await runGrading(f.deps);
    expect([f.letters.map((l) => [l.id, l.reason]), r.graded, r.gradeLetters]).toEqual([
      [
        [id(1), "read_failed"],
        [id(2), "refused"],
        [id(3), "grade_failed"],
        [id(4), "record_refused"],
      ],
      0,
      4,
    ]);
  });

  it("gives a message that fails again after a Retry a new letter key", async () => {
    const f = fake({
      gradeLetters: async () => [{ idempotencyKey: `mail.grade:${id(1)}:1`, action: "retry" }],
      extract: async () => ({ kind: "needs_human", reason: "truncated", record: RECORD }),
    });
    await runGrading(f.deps);
    expect(f.letters.map((l) => l.key)).toEqual([`mail.grade:${id(1)}:2`]);
  });

  it("stops grading, with no letter, when the model is held back or the API or Gmail doesn't answer", async () => {
    for (const error of [
      new HeldBack("kill_switch", "agent:recruiter-extract"),
      new LlmTransportError({ status: 503, retryable: true }),
    ]) {
      const f = fake({
        ungraded: async () => [row(1), row(2)],
        extract: async () => {
          throw error;
        },
      });
      const r = await runGrading(f.deps);
      expect([r.gradeStoppedBy, f.letters, r.moreToGrade]).toEqual([error.name, [], true]);
    }
    const gmailDown = fake({
      readFull: async () => {
        throw new GmailError("Gmail answered 503", 503);
      },
    });
    expect((await runGrading(gmailDown.deps)).gradeStoppedBy).toBe("GmailError");
  });

  it("stops rather than lettering every email when the route answers that it is off", async () => {
    const f = fake({
      ungraded: async () => [row(1), row(2)],
      extract: async () => ({ kind: "off" }),
    });
    const r = await runGrading(f.deps);
    expect([r.gradeStoppedBy, f.letters, r.graded]).toEqual(["RecruiterExtractOff", [], 0]);
  });
});
