import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailClient } from "../gmail.js";
import { isJobMail } from "../prefilter.js";
import { type LinkStepDeps, linkNewMessage } from "./step.js";
import { tagFromDeliveredTo } from "./tag.js";

// The producer for the mail-link step (NS-247, #293 item 1; INB-002, INB-009). Push was dropped
// on #89, so this polls: it lists received mail after a time, oldest first, and hands each job
// message to `linkNewMessage`. It reads ids and headers only, through the read-only client with
// its in-memory token (ADR-0014). The step records each decision once, so the overlap and a rerun
// never record twice.
//
// The cursor is the caller's: a running process keeps `nextSince` between ticks. A stored cursor
// needs a migration and comes later.

// At most this many messages a run, so one run's Gmail reads stay bounded.
export const MAX_PER_POLL = 200;
// How far before `since` each run looks again: Gmail's `after:` is in whole seconds, and mail can
// show up in a search a little after its receive time.
export const POLL_OVERLAP_MS = 60 * 60 * 1000;

export type MailPollDeps = LinkStepDeps & {
  gmail: Pick<GmailClient, "listIds" | "getHeaders">;
  // The run's start: `nextSince` never passes it.
  now: () => Date;
  // Company mail domains for the INB-002 pre-filter. None are stored yet (#293 item 3), so the
  // pre-filter passes ATS senders Gmail authenticated and job phrases only.
  knownDomains: ReadonlySet<string>;
};

export type MailPollReport = {
  listed: number;
  handled: number;
  linked: number;
  queued: number;
  skipped: number;
  notJobMail: number;
  // Messages the caller asked to pass over (`skip`): dead-lettered after repeated failures.
  passedOver: number;
  // More were listed than one run handles; the rest come on the next tick.
  truncated: boolean;
  // The receive time of the last message handled (or `since` when none was): the next tick's
  // `since`.
  nextSince: Date;
  // The next tick's `overlap`: false after a truncated run. Looking back an hour then would list
  // the same oldest 200 again whenever 200 or more messages arrived in that hour, and the cursor
  // would never move.
  nextOverlap: boolean;
  // The error's name when a message's read or step failed. The run stops there, so nothing after
  // it is passed over: the next tick starts again from `nextSince`.
  stoppedBy: string | null;
  // The Gmail id of the message the run stopped at, for the caller to count repeated stops and,
  // after a few, record a dead letter and pass the id back in `skip`. In the report only, never on
  // a span or in a log.
  stoppedAt: string | null;
};

// Received mail after `since` (less the overlap, when asked for). Sent mail, drafts, spam, trash
// and chats are left out of the search; the step skips spam and trash by their labels too.
// Gmail's `after:` is in whole seconds, so without the overlap the boundary second is still read
// again, and the step records nothing twice.
export function newMailQuery(since: Date, overlap = true): string {
  const after = Math.floor((since.getTime() - (overlap ? POLL_OVERLAP_MS : 0)) / 1000);
  return `after:${after} -in:sent -in:drafts -in:spam -in:trash -in:chats`;
}

const tracer = trace.getTracer("@northstar/inbox");

export function pollNewMail(
  deps: MailPollDeps,
  // `skip`: ids the caller has given up on (a dead letter each), passed over so one message that
  // always fails can't hold back all the mail after it.
  // `overlap`: pass back the last report's `nextOverlap` (true for a first run).
  opts: { since: Date; overlap?: boolean; skip?: ReadonlySet<string> },
): Promise<MailPollReport> {
  return tracer.startActiveSpan("mail.poll", async (span) => {
    try {
      const report = await poll(deps, opts.since, opts.overlap ?? true, opts.skip ?? new Set());
      // Counts only: never an address, subject or id.
      for (const key of [
        "listed",
        "handled",
        "linked",
        "queued",
        "skipped",
        "notJobMail",
        "passedOver",
      ] as const) {
        span.setAttribute(`northstar.mail_poll.${key}`, report[key]);
      }
      span.setAttribute("northstar.mail_poll.truncated", report.truncated);
      if (report.stoppedBy !== null) {
        span.setAttribute("northstar.mail_poll.stopped_by", report.stoppedBy);
      }
      return report;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).name });
      throw e;
    } finally {
      span.end();
    }
  });
}

async function poll(
  deps: MailPollDeps,
  since: Date,
  overlap: boolean,
  skip: ReadonlySet<string>,
): Promise<MailPollReport> {
  const startedAt = deps.now();
  // A failed listing throws (a held-back breaker, Gmail down): nothing was read or recorded, and
  // the caller tries again with the same `since`.
  const listed = await deps.gmail.listIds(newMailQuery(since, overlap));
  // Gmail lists newest first; oldest first means a run that stops early never passes over mail.
  const ordered = [...listed].reverse();
  const batch = ordered.slice(0, MAX_PER_POLL);
  const tags = new Set((await deps.readTags()).map((t) => t.tag));
  const report: MailPollReport = {
    listed: listed.length,
    handled: 0,
    linked: 0,
    queued: 0,
    skipped: 0,
    notJobMail: 0,
    passedOver: 0,
    truncated: ordered.length > MAX_PER_POLL,
    nextOverlap: ordered.length <= MAX_PER_POLL,
    nextSince: since,
    stoppedBy: null,
    stoppedAt: null,
  };
  for (const { id } of batch) {
    if (skip.has(id)) {
      report.passedOver++;
      report.handled++;
      continue;
    }
    try {
      const headers = await deps.gmail.getHeaders(id);
      const tag = tagFromDeliveredTo(headers.deliveredTo);
      // INB-002's pre-filter, or mail to one of Paul's known tags (INB-009: always job mail).
      const passes =
        isJobMail(headers, deps.knownDomains) || (tag.kind === "tag" && tags.has(tag.tag));
      if (!passes) {
        report.notJobMail++;
      } else {
        const result = await linkNewMessage(deps, headers);
        report[result.kind]++;
      }
      report.handled++;
      // Never backwards (Gmail's order and receive times can disagree by a little), and never past
      // the run's start: an app that imports mail can set its receive time, and one dated in the
      // future must not make later runs pass over real mail.
      const at = new Date(Math.min(headers.receivedAt.getTime(), startedAt.getTime()));
      if (at > report.nextSince) report.nextSince = at;
    } catch (e) {
      report.stoppedBy = e instanceof Error ? e.name : "Error";
      report.stoppedAt = id;
      break;
    }
  }
  return report;
}
