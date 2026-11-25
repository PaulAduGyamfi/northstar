import { CandidateId } from "@northstar/domain";
import type { Db } from "./db.js";
import { candidate } from "./schema.js";

// Single tenant today (Q-02): the one candidate, created on first use. More than one is an error
// rather than a guess about whose profile to change.
export async function soleCandidate(db: Db): Promise<CandidateId> {
  const rows = await db.select({ id: candidate.id }).from(candidate).limit(2);
  if (rows.length > 1) throw new Error("more than one candidate; pick one explicitly");
  const existing = rows[0];
  if (existing) return CandidateId.parse(existing.id);
  const [created] = await db.insert(candidate).values({ displayName: "Candidate" }).returning();
  if (!created) throw new Error("candidate insert returned no row");
  return CandidateId.parse(created.id);
}
