import type { Watch } from "@northstar/db";
import { type BoardTarget, detectBoard } from "./boards/detect.js";
import type { PassSummary } from "./poll.js";
import { TIER_MINUTES } from "./poll.js";

// `jobs watch add|list|remove|retry`, `jobs poll` and `jobs run` (NS-115). Injected, like cli.ts.
export type BoardCliDeps = {
  add: (
    target: BoardTarget,
    tier: 1 | 2 | 3,
  ) => Promise<{ status: "added" | "exists"; id: string }>;
  list: () => Promise<Watch[]>;
  remove: (id: string) => Promise<boolean>;
  retry: (id: string) => Promise<boolean>;
  poll: () => Promise<PassSummary>;
  // Waits between passes; false means stop (Ctrl-C).
  wait: (ms: number) => Promise<boolean>;
};

type Io = { print: (line: string) => void; now: () => Date; boards: BoardCliDeps };

export const TICK_MS = 60_000;

const BOARDS =
  "boards.greenhouse.io/<board>, jobs.lever.co/<company>, jobs.ashbyhq.com/<org>, jobs.smartrecruiters.com/<Company> or apply.workable.com/<account>";

export async function watchCommand(io: Io, args: string[]): Promise<number | null> {
  const [sub, ...rest] = args;
  if (sub === "add" && rest.length === 3 && rest[1] === "--tier") {
    return add(io, rest[0] ?? "", rest[2] ?? "");
  }
  if (sub === "list" && rest.length === 0) return list(io);
  if ((sub === "remove" || sub === "retry") && rest.length === 1 && rest[0]) {
    const id = rest[0];
    const done = sub === "remove" ? await io.boards.remove(id) : await io.boards.retry(id);
    io.print(
      !done
        ? `No watched board ${id}.`
        : sub === "remove"
          ? `Stopped watching ${id}.`
          : `Board ${id} is back to ok and is due now.`,
    );
    return done ? 0 : 1;
  }
  return null;
}

async function add(io: Io, url: string, rawTier: string): Promise<number> {
  const target = detectBoard(url);
  if (!target) {
    io.print(`Not watched: that isn't a job board link. Use a board's own page: ${BOARDS}.`);
    return 1;
  }
  const tier = Number(rawTier);
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    io.print("Not watched: --tier is 1 (dream, every 10 min), 2 (every 20 min) or 3 (hourly).");
    return 1;
  }
  const r = await io.boards.add(target, tier);
  io.print(
    r.status === "exists"
      ? `Already watching that board (${r.id}).`
      : `Watching ${target.ats} board ${target.board} (tier ${tier}, every ${TIER_MINUTES[tier]} min). First poll on the next jobs poll or jobs run.`,
  );
  return 0;
}

async function list(io: Io): Promise<number> {
  const watches = await io.boards.list();
  if (watches.length === 0) {
    io.print("No boards watched. Add one with: jobs watch add <board-url> --tier 1|2|3");
    return 0;
  }
  const now = io.now();
  for (const w of watches) {
    const read = w.lastSuccessAt ? `last read ${since(w.lastSuccessAt, now)}` : "not read yet";
    const status =
      w.status === "quarantined"
        ? `quarantined after ${w.consecutiveFailures} failures (${w.lastError ?? "unknown"}): jobs watch retry ${w.id}`
        : w.status === "backing_off"
          ? `backing off after ${w.consecutiveFailures} failures (${w.lastError ?? "unknown"})`
          : "ok";
    io.print(
      `${w.id}  ${w.ats}/${w.board} · tier ${w.tier} · ${status} · ${read} · ${w.jobsFound} jobs found`,
    );
  }
  return 0;
}

export async function pollCommand(io: Io): Promise<number> {
  io.print(summary(await io.boards.poll()));
  return 0;
}

// Polls once a minute until stopped (ADR-0015). A failed pass (database down, say) is printed by
// name and retried on the next tick; it never ends the loop.
export async function runCommand(io: Io): Promise<number> {
  io.print("Polling watched boards once a minute. Ctrl-C to stop.");
  for (;;) {
    try {
      const s = await io.boards.poll();
      if (s.boards > 0) io.print(`${io.now().toISOString()}  ${summary(s)}`);
    } catch (error) {
      // Named, never quoted: a database error's message can carry connection details.
      const name = error instanceof Error ? error.name : "an unknown error";
      io.print(`${io.now().toISOString()}  pass failed (${name}); trying again in a minute.`);
    }
    if (!(await io.boards.wait(TICK_MS))) return 0;
  }
}

function summary(s: PassSummary): string {
  if (s.boards === 0) return "No boards due.";
  const parts = [`${s.added} new job${s.added === 1 ? "" : "s"}`];
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  if (s.quarantined > 0) parts.push(`${s.quarantined} quarantined (see jobs watch list)`);
  return `Polled ${s.boards} board${s.boards === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

function since(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  return minutes < 120 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}
