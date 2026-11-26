import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { killSwitch, SUBSYSTEM_PATTERN } from "./resilience-schema.js";

// Kill switches per subsystem (RES-008, ADR-0007 item 6). Append-only rows; the newest per
// subsystem is its state, and a subsystem with no row is on. Reads go straight to Postgres, so
// a flip takes effect on the next check.

// The subsystems a switch can name; the database CHECK uses the same pattern.
const SUBSYSTEM = new RegExp(SUBSYSTEM_PATTERN);

export type SetKillSwitchResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: { kind: "InvalidSubsystem" } | { kind: "ReasonRequired" } };

// Turns a subsystem off (`enabled: false`) or back on, with who and why. Setting the state it is
// already in stores nothing and writes no event.
export async function setKillSwitch(
  db: Db,
  input: {
    candidateId: CandidateId;
    subsystem: string;
    enabled: boolean;
    actor: "user" | "system";
    reason: string;
  },
): Promise<SetKillSwitchResult> {
  if (!SUBSYSTEM.test(input.subsystem)) return { ok: false, error: { kind: "InvalidSubsystem" } };
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 200) {
    return { ok: false, error: { kind: "ReasonRequired" } };
  }
  return inSpan(
    "kill_switch.set",
    { "northstar.subsystem": input.subsystem, "northstar.kill_switch.enabled": input.enabled },
    (span) =>
      db.transaction(async (tx) => {
        // One flip per subsystem at a time: two flips racing would otherwise both read "on".
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`kill_switch:${input.candidateId}:${input.subsystem}`}))`,
        );
        const current = await currentState(tx, input.candidateId, input.subsystem);
        if (current === input.enabled) return { ok: true, changed: false };
        const [row] = await tx
          .insert(killSwitch)
          .values({
            candidateId: input.candidateId,
            subsystem: input.subsystem,
            enabled: input.enabled,
            actor: input.actor,
            reason,
          })
          .returning({ id: killSwitch.id, setAt: killSwitch.setAt });
        if (!row) throw new Error("kill_switch insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `kill_switch:${row.id}`,
          type: "kill_switch.set",
          actor: input.actor,
          reason: input.enabled ? `Turned ${input.subsystem} on` : `Turned ${input.subsystem} off`,
          // Paul's reason is shown on the health view (systemHealth), never in the feed. It is
          // his note on why, never a code or a secret.
          payload: { subsystem: input.subsystem, enabled: input.enabled, reason },
          idempotencyKey: `kill-switch:${row.id}`,
          at: row.setAt,
        });
        return { ok: true, changed: true };
      }),
  );
}

type Reader = Pick<Db, "select">;

// Also used inside the vault's open transaction (vault-write.ts), so "no row means on" lives here
// only.
export async function currentState(db: Reader, candidateId: CandidateId, subsystem: string) {
  const [row] = await db
    .select({ enabled: killSwitch.enabled })
    .from(killSwitch)
    .where(and(eq(killSwitch.candidateId, candidateId), eq(killSwitch.subsystem, subsystem)))
    .orderBy(desc(killSwitch.position))
    .limit(1);
  // No row: the subsystem has never been switched off.
  return row?.enabled ?? true;
}

// Is this subsystem on? Every automated action checks this right before it acts.
export async function isSubsystemOn(
  db: Db,
  candidateId: CandidateId,
  subsystem: string,
): Promise<boolean> {
  if (!SUBSYSTEM.test(subsystem)) throw new Error("invalid subsystem name");
  return currentState(db, candidateId, subsystem);
}

export type KillSwitchView = {
  subsystem: string;
  enabled: boolean;
  actor: string;
  reason: string;
  setAt: Date;
};

// The current state of every subsystem that has ever been switched, by name.
export async function readKillSwitches(
  db: Db,
  candidateId: CandidateId,
): Promise<KillSwitchView[]> {
  const rows = await db
    .selectDistinctOn([killSwitch.subsystem], {
      subsystem: killSwitch.subsystem,
      enabled: killSwitch.enabled,
      actor: killSwitch.actor,
      reason: killSwitch.reason,
      setAt: killSwitch.setAt,
    })
    .from(killSwitch)
    .where(eq(killSwitch.candidateId, candidateId))
    .orderBy(killSwitch.subsystem, desc(killSwitch.position));
  return rows;
}
