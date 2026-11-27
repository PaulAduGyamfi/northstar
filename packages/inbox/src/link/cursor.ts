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

export async function pollFromCursor(
  deps: MailPollDeps & { cursor: CursorPort },
  // `firstSince`: where the very first run starts, before any cursor is stored.
  // `skip`: ids the caller dead-lettered, as for pollNewMail.
  opts: { firstSince: Date; skip?: ReadonlySet<string> },
): Promise<MailPollReport> {
  const stored = await deps.cursor.read();
  const report = await pollNewMail(deps, {
    since: stored?.since ?? opts.firstSince,
    overlap: stored?.overlap ?? true,
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  // Saved even when the run stopped at a message: `nextSince` is then the last message handled
  // before the stop, so nothing after it is skipped. A failed save is thrown; the next tick reads
  // the old cursor again, and the step records nothing twice.
  await deps.cursor.save({ since: report.nextSince, overlap: report.nextOverlap });
  return report;
}
