import type { AtomView, InterviewAnswer } from "@northstar/db";
import type { CallRecord, LlmGateway, Route } from "@northstar/llm";
import { isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import type { StoryDraftInput } from "./story-route.js";
import { STAR_PARTS, type StoryDraft } from "./story-schema.js";
import { type StoryFailure, validateStoryDraft } from "./story-validate.js";

// The guided story interview (CPG-003, NS-111): a fixed STAR script about one atom, a drafted
// story with at most one round of model follow-ups, the provenance check, then Paul's decision.
// Every answer is saved as soon as he gives it, so stopping halfway loses nothing.

// The script, asked in order. The last question is optional: an empty answer skips it.
export const SCRIPT = [
  "Situation: what was going on, and why did it matter?",
  "Task: what were you responsible for?",
  "Action: what did you do, step by step?",
  "Result: what changed? Any numbers you can stand behind?",
  "Anything else worth telling? (optional, press Enter to skip)",
] as const;
const REQUIRED = SCRIPT.length - 1;

export type Choice = "approve" | "redraft" | "skip";

// Paul's terminal. `ask` and `choose` return null when input closes (Ctrl-D, a closed terminal).
export type Terminal = {
  print: (line: string) => void;
  ask: (question: string) => Promise<string | null>;
  choose: (options: Choice[]) => Promise<Choice | null>;
};

type Trace = { traceId: string | null };

// The database side, bound to Paul's candidate id by the caller (bin.ts → @northstar/db).
export type InterviewStore = {
  nextAtom: (atomId?: string) => Promise<AtomView | null>;
  start: (input: { atomId: string } & Trace) => Promise<{ interviewId: string; resumed: boolean }>;
  answers: (interviewId: string) => Promise<InterviewAnswer[]>;
  record: (input: InterviewAnswer & { interviewId: string } & Trace) => Promise<void>;
  draftOutcome: (
    input: {
      interviewId: string;
      round: number;
      outcome: "drafted" | "rejected";
      reason: string | null;
      failureCount: number;
      call: Record<string, unknown>;
    } & Trace,
  ) => Promise<void>;
  approve: (
    input: {
      interviewId: string;
      draft: StoryDraft;
      promptVersion: number;
      model: string;
    } & Trace,
  ) => Promise<string>;
  abandon: (input: { interviewId: string } & Trace) => Promise<void>;
};

export type InterviewDeps = {
  store: InterviewStore;
  terminal: Terminal;
  gateway: LlmGateway;
  route: Route<StoryDraftInput, StoryDraft>;
};

export type InterviewOutcome =
  // Every model call the interview made (follow-up round, redrafts), for the cost line (OBV-003).
  | { kind: "approved"; storyId: string; records: CallRecord[] }
  | { kind: "skipped" }
  | { kind: "stopped" }
  | { kind: "no_atoms" }
  | { kind: "atom_not_found" };

export async function runInterview(
  deps: InterviewDeps,
  input: { atomId?: string },
): Promise<InterviewOutcome> {
  return trace
    .getTracer("@northstar/profile")
    .startActiveSpan("profile.interview", async (span) => {
      const stats: Stats = { rounds: 0, followUps: 0, records: [] };
      try {
        const context = span.spanContext();
        const traceId = isSpanContextValid(context) ? context.traceId : null;
        const outcome = await interview(deps, input, traceId, stats);
        span.setAttribute("northstar.interview.outcome", outcome.kind);
        return outcome;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        throw error;
      } finally {
        // Set on failure too (an API outage mid-interview), so the trace shows how far it got.
        span.setAttributes({
          "northstar.interview.rounds": stats.rounds,
          "northstar.interview.follow_ups": stats.followUps,
        });
        span.end();
      }
    });
}

type Stats = { rounds: number; followUps: number; records: CallRecord[] };

async function interview(
  deps: InterviewDeps,
  input: { atomId?: string },
  traceId: string | null,
  stats: Stats,
): Promise<InterviewOutcome> {
  const { store, terminal } = deps;
  const atom = await store.nextAtom(input.atomId);
  if (!atom) return input.atomId ? { kind: "atom_not_found" } : { kind: "no_atoms" };
  trace.getActiveSpan()?.setAttribute("northstar.interview.atom_id", atom.id);

  const { interviewId, resumed } = await store.start({ atomId: atom.id, traceId });
  showAtom(terminal, atom, resumed);

  // The script, skipping questions a resumed session already answered.
  const given = new Set((await store.answers(interviewId)).map((a) => a.position));
  for (const [position, question] of SCRIPT.entries()) {
    if (given.has(position)) continue;
    const answer = await askUntilAnswered(terminal, question, position < REQUIRED);
    if (answer === null) return stopped(terminal);
    await store.record({ interviewId, position, question, answer, traceId });
  }

  // Follow-ups happen once per interview: a resumed session that already answered some goes
  // straight to the final draft.
  let followUpsDone = (await store.answers(interviewId)).some((a) => a.position >= SCRIPT.length);
  const draftInput = async (): Promise<StoryDraftInput> => ({
    atom: { id: atom.id, what: atom.what, sourceQuote: atom.sourceQuote },
    answers: await store.answers(interviewId),
  });

  for (;;) {
    stats.rounds += 1;
    const round = stats.rounds;
    const evidence = await draftInput();
    const outcome = await deps.gateway.call(deps.route, evidence);
    stats.records.push(outcome.record);
    const call = { ...outcome.record };

    let failures: StoryFailure[] = [];
    if (outcome.kind === "Ok") {
      const check = validateStoryDraft(outcome.output, evidence);
      if (!check.ok) failures = check.failures;
    }
    if (outcome.kind !== "Ok" || failures.length > 0) {
      const reason = outcome.kind === "Ok" ? "provenance" : outcome.kind;
      await store.draftOutcome({
        interviewId,
        round,
        outcome: "rejected",
        reason,
        failureCount: failures.length,
        call,
        traceId,
      });
      terminal.print(rejectedLine(reason));
      for (const f of failures) terminal.print(`  - ${f.item}: ${f.problem}`);
      const choice = await terminal.choose(["redraft", "skip"]);
      if (choice === "redraft") continue;
      return choice === "skip" ? skip(deps, interviewId, traceId) : stopped(terminal);
    }

    const draft = outcome.output;
    await store.draftOutcome({
      interviewId,
      round,
      outcome: "drafted",
      reason: null,
      failureCount: 0,
      call,
      traceId,
    });

    if (!followUpsDone && draft.followUps.length > 0) {
      followUpsDone = true;
      terminal.print("A couple more questions to fill the story in:");
      for (const [k, question] of draft.followUps.entries()) {
        const answer = await askUntilAnswered(terminal, question, false);
        if (answer === null) return stopped(terminal);
        stats.followUps += 1;
        await store.record({
          interviewId,
          position: SCRIPT.length + k,
          question,
          answer,
          traceId,
        });
      }
      continue;
    }

    showDraft(terminal, draft);
    const choice = await terminal.choose(["approve", "redraft", "skip"]);
    if (choice === "redraft") continue;
    if (choice === "skip") return skip(deps, interviewId, traceId);
    if (choice === null) return stopped(terminal);
    const storyId = await store.approve({
      interviewId,
      draft,
      promptVersion: deps.route.prompt.version,
      model: outcome.record.modelServed,
      traceId,
    });
    terminal.print("Saved to your story bank.");
    return { kind: "approved", storyId, records: stats.records };
  }
}

// Asks until Paul answers. A required question re-asks on an empty answer; an optional one
// accepts it (stored empty, so a resumed session doesn't ask again).
async function askUntilAnswered(
  terminal: Terminal,
  question: string,
  required: boolean,
): Promise<string | null> {
  for (;;) {
    const answer = await terminal.ask(question);
    if (answer === null) return null;
    const trimmed = answer.trim();
    if (trimmed !== "" || !required) return trimmed;
    terminal.print("An answer helps here. Type it, or press Ctrl-D to stop and come back later.");
  }
}

function showAtom(terminal: Terminal, atom: AtomView, resumed: boolean): void {
  terminal.print(resumed ? "Picking up where you left off." : "New story.");
  if (atom.employer !== null) terminal.print(`Role: ${atom.title ?? ""} at ${atom.employer}`);
  terminal.print(`Atom: ${atom.what}`);
  terminal.print(`Resume line: ${atom.sourceQuote}`);
}

function showDraft(terminal: Terminal, draft: StoryDraft): void {
  terminal.print("");
  terminal.print(`Draft: ${draft.title}`);
  for (const part of STAR_PARTS) {
    terminal.print(`${part[0]?.toUpperCase()}${part.slice(1)}: ${draft[part].text}`);
    for (const quote of draft[part].quotes) terminal.print(`    from your answer: "${quote}"`);
  }
  terminal.print(`Competencies: ${draft.competencies.join(", ")}`);
}

// What went wrong, with no draft text (it may be partly invented).
function rejectedLine(reason: string): string {
  switch (reason) {
    case "provenance":
      return "The draft said things your answers don't, so it was thrown away:";
    case "Refused":
      return "The model declined to draft this story. Nothing was saved.";
    case "Truncated":
      return "The draft was cut off before it finished. Nothing was saved.";
    default:
      return "The draft came back malformed. Nothing was saved.";
  }
}

async function skip(
  deps: InterviewDeps,
  interviewId: string,
  traceId: string | null,
): Promise<InterviewOutcome> {
  await deps.store.abandon({ interviewId, traceId });
  deps.terminal.print("Skipped. Your answers are kept; this atom won't be offered again.");
  return { kind: "skipped" };
}

function stopped(terminal: Terminal): InterviewOutcome {
  terminal.print("Stopped. Your answers are saved; run `profile interview` to pick up again.");
  return { kind: "stopped" };
}
