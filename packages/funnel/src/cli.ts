import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  FunnelMessageRow,
  MailKind,
  ManualRowInput,
  ReviewDecision,
  ReviewError,
  StageSignal,
} from "@northstar/db";
import type { Result } from "@northstar/domain";
import { GmailError, MAIL_KINDS, OAuthError, STAGE_SIGNALS } from "@northstar/inbox";
import { describeHeldBack, HeldBack, LlmTransportError } from "@northstar/llm";
import { type BackfillCounts, emptyCounts } from "./backfill.js";
import { parseTracker } from "./csv.js";
import { type DraftsRunReport, draftsCommand } from "./drafts.js";
import { judgeHypotheses, summarize } from "./hypotheses.js";
import { type InboxRunReport, inboxCommand } from "./inbox.js";
import { type InterviewsRun, interviewsCommand } from "./interviews.js";
import { type PrepRunReport, prepCommand } from "./prep.js";
import { gmailRecords, mergeRecords } from "./records.js";
import { type Baselines, buildReport, renderReport } from "./report.js";

// `funnel backfill | import | review | report | hypotheses` (NS-113), `interviews` (NS-240),
// `inbox` (NS-238), `prep` (NS-241) and `drafts` (NS-281). Everything is injected, so
// tests run with no database, Gmail or model. Output shows Paul's own job data back to Paul only.
export type CliDeps = {
  argv: string[];
  print: (line: string) => void;
  // One answer from Paul's keyboard; null when input closes (Ctrl-D).
  ask: (question: string) => Promise<string | null>;
  now: () => Date;
  baselines: Baselines;
  // Fills `counts` as it goes, so a stopped run still reports its progress.
  runBackfill: (
    options: { since: string; maxMessages: number },
    counts: BackfillCounts,
  ) => Promise<BackfillCounts>;
  readText: (path: string) => Promise<string>;
  setManualRows: (input: {
    fileSha256: string;
    rows: ManualRowInput[];
  }) => Promise<{ status: "imported" | "unchanged"; rows: number }>;
  readMessages: () => Promise<FunnelMessageRow[]>;
  readManualRows: () => Promise<ManualRowInput[]>;
  latestFactsCheck: () => Promise<{ mismatches: number } | null>;
  resolveReview: (
    messageId: string,
    decision: ReviewDecision,
  ) => Promise<Result<{ status: "classified" | "discarded" }, ReviewError>>;
  // Calendar consent and one detection run (NS-240 slice 6): the token lives only inside it.
  runInterviews: () => Promise<InterviewsRun>;
  // Gmail consent and one mail-loop run (NS-238 item 1): the token lives only inside it.
  runInbox: () => Promise<InboxRunReport>;
  // Prep plans and, when one is approved, Calendar write consent for this run (NS-241 slice 5);
  // with busyFromCalendar, read-only Calendar consent too, for busy time (slice 7).
  runPrep: (options: { busyFromCalendar: boolean }) => Promise<PrepRunReport>;
  // Approved replies and, when one is waiting, gmail.compose consent for this run (NS-281 slice 1).
  runDrafts: () => Promise<DraftsRunReport>;
  recordEvent: (
    type: "funnel.backfilled" | "funnel.reported",
    reason: string,
    payload: Record<string, number | string | null>,
  ) => Promise<void>;
};

const USAGE =
  "usage: funnel backfill [--since YYYY-MM-DD] [--max-messages N] | funnel import <file.csv> | funnel review | funnel report | funnel hypotheses | funnel interviews | funnel inbox | funnel prep [--busy-from-calendar] | funnel drafts";

export async function main(deps: CliDeps): Promise<number> {
  const [command, ...rest] = deps.argv;
  if (command === "backfill") {
    const options = parseBackfillFlags(rest);
    if (options) return backfillCommand(deps, options);
  }
  if (command === "import" && rest.length === 1 && rest[0]) return importCommand(deps, rest[0]);
  if (command === "review" && rest.length === 0) return reviewCommand(deps);
  if (command === "report" && rest.length === 0) return reportCommand(deps);
  if (command === "hypotheses" && rest.length === 0) return hypothesesCommand(deps);
  if (command === "interviews" && rest.length === 0) return interviewsCommand(deps);
  if (command === "inbox" && rest.length === 0) return inboxCommand(deps);
  if (command === "prep" && (rest.length === 0 || (rest.length === 1 && rest[0] === BUSY_FLAG))) {
    const busyFromCalendar = rest.length === 1;
    return prepCommand({ print: deps.print, runPrep: () => deps.runPrep({ busyFromCalendar }) });
  }
  if (command === "drafts" && rest.length === 0) {
    return draftsCommand({ print: deps.print, runDrafts: deps.runDrafts });
  }
  deps.print(USAGE);
  return 1;
}

// Opt-in: plan prep around Paul's own calendar too (NS-241 slice 7).
const BUSY_FLAG = "--busy-from-calendar";

// DX-001: nine months back from the search's start.
const DEFAULT_SINCE = "2026-02-01";
const DEFAULT_MAX = 500;

function parseBackfillFlags(flags: string[]): { since: string; maxMessages: number } | null {
  let since = DEFAULT_SINCE;
  let maxMessages = DEFAULT_MAX;
  for (let i = 0; i < flags.length; i += 2) {
    const value = flags[i + 1];
    if (value === undefined) return null;
    if (flags[i] === "--since" && /^\d{4}-\d{2}-\d{2}$/.test(value)) since = value;
    else if (flags[i] === "--max-messages" && /^\d{1,5}$/.test(value)) maxMessages = Number(value);
    else return null;
  }
  return { since, maxMessages };
}

async function backfillCommand(
  deps: CliDeps,
  options: { since: string; maxMessages: number },
): Promise<number> {
  let c = emptyCounts();
  try {
    c = await deps.runBackfill(options, c);
  } catch (error) {
    deps.print(`Backfill stopped: ${describeError(error)}`);
    deps.print("Messages already processed are saved; run it again to continue.");
    // If it isn't in the feed, it didn't happen: a stopped run may already have cost money.
    await deps.recordEvent("funnel.backfilled", "Gmail backfill stopped", {
      ...countsPayload(c),
      stopped: error instanceof Error ? error.name : "unknown",
    });
    return 1;
  }
  deps.print(
    `Listed ${c.listed} (${c.alreadyKnown} already done). Not job mail: ${c.notJob}. By rules: ${c.ruleClassified}. By the model: ${c.modelClassified}. For your review: ${c.review}.`,
  );
  deps.print(
    `${c.modelCalls} model call(s), ${c.costUsd === null ? "cost unknown" : `$${Math.round(c.costUsd * 1e4) / 1e4}`}.${c.deferred > 0 ? ` ${c.deferred} left for the next run.` : ""}`,
  );
  // VER-005: only the count, never a subject or sender.
  if (c.verificationSkipped > 0) deps.print(`Verification mail skipped: ${c.verificationSkipped}.`);
  if (c.review > 0) deps.print("Run `funnel review` to place the messages that need you.");
  await deps.recordEvent("funnel.backfilled", "Gmail backfill finished", countsPayload(c));
  return 0;
}

const countsPayload = (c: BackfillCounts): Record<string, number | null> => ({ ...c });

// Errors this package raises carry no mail content by construction (status codes, fixed words);
// anything else is named only, since its message might quote a row or a request.
function describeError(error: unknown): string {
  if (error instanceof OAuthError || error instanceof GmailError) return error.message;
  if (error instanceof LlmTransportError) {
    return `the Claude API didn't answer (status ${error.status ?? "none"})`;
  }
  // A kill switch or breaker (NS-174): nothing went out; rerunning later is safe.
  if (error instanceof HeldBack) return `${describeHeldBack(error)}; run it again later`;
  return error instanceof Error ? error.name : "an unknown error";
}

async function importCommand(deps: CliDeps, path: string): Promise<number> {
  const name = basename(path);
  const text = await deps.readText(path);
  const parsed = parseTracker(text);
  if (!parsed.ok) {
    deps.print(`Not imported: ${name} has problems. Nothing was changed.`);
    for (const e of parsed.error) deps.print(`  line ${e.line}: ${e.problem}`);
    return 1;
  }
  const fileSha256 = createHash("sha256").update(text).digest("hex");
  const result = await deps.setManualRows({ fileSha256, rows: parsed.value });
  deps.print(
    result.status === "imported"
      ? `Imported ${result.rows} row(s) from ${name}. Run \`funnel report\` to see the funnel.`
      : `${name} is unchanged since the last import. Nothing to do.`,
  );
  return 0;
}

async function records(deps: CliDeps) {
  const now = deps.now();
  const gmail = gmailRecords(await deps.readMessages(), now);
  return mergeRecords(gmail, await deps.readManualRows());
}

async function reportCommand(deps: CliDeps): Promise<number> {
  const { records: all, conflicts } = await records(deps);
  const report = buildReport(all, deps.baselines, deps.now());
  for (const line of renderReport(report)) deps.print(line);
  if (conflicts.length > 0) {
    deps.print(
      `${conflicts.length} application(s) where your tracker and Gmail disagree on the outcome (your tracker wins):`,
    );
    for (const c of conflicts) {
      deps.print(
        `  ${c.company} · ${c.role ?? "?"}: tracker ${c.trackerOutcome}, Gmail ${c.gmailOutcome}`,
      );
    }
  }
  await deps.recordEvent("funnel.reported", "Funnel report shown", {
    applications: report.total,
    tooNew: report.tooNew,
    // A fixed step name, never a company.
    leakiest: report.leakiest ? `${report.leakiest.from}>${report.leakiest.to}` : null,
    conflicts: conflicts.length,
  });
  return 0;
}

async function hypothesesCommand(deps: CliDeps): Promise<number> {
  const { records: all } = await records(deps);
  const report = buildReport(all, deps.baselines, deps.now());
  const board = judgeHypotheses(report, all, await deps.latestFactsCheck());
  deps.print(summarize(board, report));
  for (const h of board) {
    deps.print(`${h.id} ${h.title}: ${h.status}. ${h.evidence}.`);
    if (h.status !== "weakened") deps.print(`    next: ${h.next}`);
  }
  return 0;
}

// Walks the review queue one message at a time (DX-001: nothing ambiguous lands silently). Each
// item shows only what's stored (date, sender domain, why it's here, any extracted names) and a
// link to open the email in Gmail itself; nothing from the email body is stored to show.
async function reviewCommand(deps: CliDeps): Promise<number> {
  const queue = (await deps.readMessages()).filter((m) => m.status === "needs_review");
  if (queue.length === 0) {
    deps.print("Nothing to review.");
    return 0;
  }
  deps.print(
    `${queue.length} message(s) to review. [p]lace in the funnel, [d]iscard, [s]kip, [q]uit.`,
  );
  let done = 0;
  for (const m of queue) {
    deps.print("");
    deps.print(
      `${m.receivedAt.toISOString().slice(0, 10)} · ${m.senderDomain ?? "?"} · ${REASON_TEXT[m.reviewReason ?? "ambiguous"]}`,
    );
    if (m.company) deps.print(`  extracted: ${m.company}${m.role ? ` · ${m.role}` : ""}`);
    deps.print(`  open it: https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.gmailId)}`);
    const choice = (await deps.ask("> "))?.trim().toLowerCase()[0];
    if (choice === undefined || choice === "q") break;
    if (choice === "s") continue;
    let decision: ReviewDecision;
    if (choice === "d") decision = { action: "discard" };
    else if (choice === "p") {
      const placed = await askPlacement(deps, m);
      if (placed === "closed") break;
      if (placed === "skip") continue;
      decision = placed;
    } else continue;
    const result = await deps.resolveReview(m.id, decision);
    if (result.ok) done += 1;
    else deps.print(`  not saved: ${result.error.kind}`);
  }
  deps.print(`${done} decision(s) saved.`);
  return 0;
}

const REASON_TEXT: Record<string, string> = {
  refused: "the model declined to classify it",
  truncated: "the model's answer was cut off",
  invalid_output: "the model's answer was malformed",
  provenance: "the model named something that isn't in the email",
  ambiguous: "it could belong to more than one application, or names no employer",
  unparseable: "Gmail returned it in a form that couldn't be read",
};

// Asks for the fields of a placement: "closed" when input closes, "skip" without a company.
async function askPlacement(
  deps: CliDeps,
  m: FunnelMessageRow,
): Promise<ReviewDecision | "closed" | "skip"> {
  const kind = await askFrom(deps, "kind", MAIL_KINDS);
  if (kind === null) return "closed";
  // No default from a name that failed the provenance check: one Enter mustn't place a name the
  // email doesn't contain.
  const trusted = m.reviewReason !== "provenance";
  const company = (
    await deps.ask(`company${trusted && m.company ? ` [${m.company}]` : ""}: `)
  )?.trim();
  if (company === undefined) return "closed";
  const role = (
    await deps.ask(`role (optional)${trusted && m.role ? ` [${m.role}]` : ""}: `)
  )?.trim();
  if (role === undefined) return "closed";
  const stage = await askFrom(deps, "stage", STAGE_SIGNALS);
  if (stage === null) return "closed";
  const finalCompany = company || (trusted ? m.company : null);
  if (!finalCompany) {
    deps.print("  a company is needed to place it; skipped.");
    return "skip";
  }
  return {
    action: "classify",
    kind: kind as MailKind,
    company: finalCompany,
    role: role || (trusted ? m.role : null),
    stageSignal: stage as StageSignal,
  };
}

async function askFrom(
  deps: CliDeps,
  name: string,
  options: readonly string[],
): Promise<string | null> {
  for (;;) {
    const answer = await deps.ask(`${name} (${options.join(", ")}): `);
    if (answer === null) return null;
    const picked = options.find((o) => o === answer.trim().toLowerCase());
    if (picked) return picked;
  }
}
