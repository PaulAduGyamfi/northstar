import { type MailPollDeps, type MailPollReport, pollNewMail } from "./poll.js";

// One poll tick with a stored cursor (NS-247 slice 2, #293): read where the last tick stopped,
// poll from there, save where this one stopped. A restart resumes from the stored cursor, so it
// neither skips mail nor reads everything again. The worker (#230) calls this once per tick, with
// `cursor` bound to readMailCursor / saveMailCursor (`packages/db`).

export type MailCursor = { since: Date; overlap: boolean };

export type CursorPort = {
  read: () => Promise<MailCursor | null>;
  save: (cursor: MailCursor) => Promise<unknown>;
};

// How far ahead of the run's start a cursor may be, as in packages/db (CURSOR_SKEW_MS).
const SKEW_MS = 5 * 60 * 1000;

// A cursor after the run's start: Gmail would list nothing after it and mail would silently stop
// being linked, so the tick fails visibly instead (security review of NS-247 slice 2).
export class FutureCursorError extends Error {
  constructor() {
    super("mail cursor is in the future");
    this.name = "FutureCursorError";
  }
}

export async function pollFromCursor(
  deps: MailPollDeps & { cursor: CursorPort },
  // `firstSince`: where the very first run starts, before any cursor is stored.
  // `skip`: ids the caller dead-lettered, as for pollNewMail.
  opts: { firstSince: Date; skip?: ReadonlySet<string> },
): Promise<MailPollReport> {
  const stored = await deps.cursor.read();
  const since = stored?.since ?? opts.firstSince;
  // Before Gmail is asked anything: a wrong `firstSince` or a stored future cursor fails here.
  if (since.getTime() > deps.now().getTime() + SKEW_MS) throw new FutureCursorError();
  const report = await pollNewMail(deps, {
    since,
    overlap: stored?.overlap ?? true,
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  // Saved even when the run stopped at a message: `nextSince` is then the last message handled
  // before the stop, so nothing after it is skipped. A failed save is thrown; the next tick reads
  // the old cursor again, and the step records nothing twice.
  await deps.cursor.save({ since: report.nextSince, overlap: report.nextOverlap });
  return report;
}
