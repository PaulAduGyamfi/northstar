import type { FunnelRecord } from "./records.js";
import { MIN_SAMPLE, type Report } from "./report.js";

// The hypothesis board (DX-004): each of 13-search-diagnostics' hypotheses gets a status, the
// evidence in numbers, and the next test. Plain rules, stated thresholds, no model. A hypothesis
// the data can't test yet says what data it needs. (The doc defines no H7.)

export type Status = "supported" | "weakened" | "untested";
export type Hypothesis = {
  id: string;
  title: string;
  status: Status;
  evidence: string;
  next: string;
};

// Share of timed rejections under 24 h at which knockout filters become the likely cause.
export const FAST_REJECTION_SHARE = 0.3;
// Share of cold applications at which "almost all cold" holds.
export const COLD_SHARE = 0.85;

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function judgeHypotheses(
  report: Report,
  records: readonly FunnelRecord[],
  factsCheck: { mismatches: number } | null,
): Hypothesis[] {
  const l = report.latency;
  const timed = l.lt24h + l.d1to7 + l.gt7d;
  const fast: Pick<Hypothesis, "status" | "evidence"> =
    timed < MIN_SAMPLE
      ? { status: "untested", evidence: `${timed} timed rejections; needs ${MIN_SAMPLE}` }
      : {
          status: (report.fastShare ?? 0) >= FAST_REJECTION_SHARE ? "supported" : "weakened",
          evidence: `${l.lt24h} of ${timed} rejections (${pct(report.fastShare ?? 0)}) came within 24 h`,
        };

  const withChannel = records.filter((r) => r.channel !== null);
  const cold = withChannel.filter((r) => r.channel === "cold").length;
  const channel: Pick<Hypothesis, "status" | "evidence"> =
    withChannel.length < MIN_SAMPLE
      ? {
          status: "untested",
          evidence: `${withChannel.length} applications with a known channel; needs ${MIN_SAMPLE} (add a channel column to your tracker)`,
        }
      : {
          status: cold / withChannel.length >= COLD_SHARE ? "supported" : "weakened",
          evidence: `${cold} of ${withChannel.length} (${pct(cold / withChannel.length)}) were cold applications`,
        };

  // A step-level hypothesis: supported when that step is the leakiest, weakened when every step it
  // covers has enough data and none is below baseline, untested otherwise.
  const byStep = (froms: string[]): Pick<Hypothesis, "status" | "evidence"> => {
    const steps = report.steps.filter((s) => froms.includes(s.from));
    const names = steps.map((s) => `${s.from} → ${s.to}`).join(", ");
    if (report.leakiest && froms.includes(report.leakiest.from)) {
      return {
        status: "supported",
        evidence: `${names}: the leakiest step, below its assumed baseline`,
      };
    }
    if (steps.every((s) => s.status === "ok")) {
      return { status: "weakened", evidence: `${names}: at or above the assumed baseline` };
    }
    return { status: "untested", evidence: `${names}: not enough data or not the leakiest step` };
  };

  const facts: Pick<Hypothesis, "status" | "evidence"> =
    factsCheck === null
      ? { status: "untested", evidence: "the employment-facts check has never run" }
      : factsCheck.mismatches > 0
        ? {
            status: "supported",
            evidence: `${factsCheck.mismatches} mismatch(es) in the last facts check`,
          }
        : { status: "weakened", evidence: "the last facts check found no mismatch" };

  const untested = (evidence: string) => ({ status: "untested" as const, evidence });
  return [
    {
      id: "H1",
      title: "Timing",
      ...untested("needs posting dates, which arrive with ATS polling (NS-115)"),
      next: "Apply within a day of posting and compare response rates by time-to-apply.",
    },
    {
      id: "H2",
      title: "ATS / keywords",
      ...fast,
      next: "Check resume parsing and the job's keywords (TLR-004) on the fast-rejected roles.",
    },
    {
      id: "H3",
      title: "Targeting / level",
      ...untested("needs fit scores per application, which arrive with fit scoring (NS-116)"),
      next: "Compare response rates by fit band and level.",
    },
    {
      id: "H4",
      title: "Positioning",
      ...byStep(["responded"]),
      next: "Rehearse the screen pitch and check comp expectations against posted ranges.",
    },
    {
      id: "H5",
      title: "Gap signal",
      ...untested("needs a gap-narrative variant test (DX-006)"),
      next: "Add the gap-to-proof section (DX-010) and compare response rates.",
    },
    {
      id: "H6",
      title: "Channel",
      ...channel,
      next: "Shift part of the weekly effort to referrals and outreach (DX-013).",
    },
    {
      id: "H8",
      title: "Interview performance",
      ...byStep(["screen", "technical"]),
      next: "Ask for feedback after technical rounds and plan practice on the weak areas.",
    },
    {
      id: "H9",
      title: "Market",
      ...untested("a market-wide question your own funnel can't settle"),
      next: "Target companies where your background is a moat (DX-012).",
    },
    {
      id: "H10",
      title: "Constraints",
      ...fast,
      next: "Check location, remote and work-authorization answers on the fast-rejected roles.",
    },
    {
      id: "H11",
      title: "Inconsistency",
      ...facts,
      next: "Run `profile facts check` and fix every mismatch it lists (NS-112).",
    },
  ];
}

// The plain-language summary on top of the board (DX-004).
export function summarize(board: readonly Hypothesis[], report: Report): string {
  // Cheapest, most certain fixes first.
  const order = ["H11", "H2", "H10", "H4", "H8", "H6"];
  const top = order
    .map((id) => board.find((h) => h.id === id && h.status === "supported"))
    .find((h) => h !== undefined);
  if (top) {
    return `Most likely problem: ${top.title} (${top.id}). Here's why: ${top.evidence}. Next: ${top.next}`;
  }
  if (report.leakiest) {
    return `Most likely problem: the ${report.leakiest.from} → ${report.leakiest.to} step, cause not clear yet. Next: gather the data the untested hypotheses below need.`;
  }
  return "Not enough data yet to name a problem. Next: run `funnel backfill` and `funnel import` with your tracker.";
}
