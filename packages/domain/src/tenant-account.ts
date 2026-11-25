import { err, ok, type Result } from "./result.js";

// The state of Paul's account on one employer tenant (NS-124, ACC-001). packages/db copies this
// list into a CHECK constraint, so the database refuses anything else.
export const ACCOUNT_STATUSES = [
  "none",
  "creating",
  "verifying",
  "active",
  "locked",
  "needs_human",
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type IllegalAccountMove = {
  kind: "IllegalAccountMove";
  from: AccountStatus;
  to: AccountStatus;
};

// Which status may follow which (specs/NS-124/spec.md). `none` → `creating` is the only way to
// start an account, so the one-account guard (ACC-006) only has to watch that move.
const ALLOWED: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  none: ["creating"],
  // An account may need an email check, be ready at once, or stop at a challenge (ACC-007).
  creating: ["verifying", "active", "needs_human"],
  verifying: ["active", "needs_human"],
  // Locked: the tenant refused the password; a reset (ACC-005) brings it back.
  active: ["locked", "needs_human"],
  locked: ["active", "needs_human"],
  // Paul finished it by hand, or says there is no account after all.
  needs_human: ["active", "none"],
};

export function nextAccountStatus(
  from: AccountStatus,
  to: AccountStatus,
): Result<AccountStatus, IllegalAccountMove> {
  return ALLOWED[from].includes(to) ? ok(to) : err({ kind: "IllegalAccountMove", from, to });
}
