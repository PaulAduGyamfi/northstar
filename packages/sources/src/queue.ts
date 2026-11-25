// Fresh-first order (SRC-013, the freshness half). Plain functions, no LLM.

// Halves every 24 hours: a 20-minute-old job scores about 0.99, a 5-day-old one about 0.03.
export function freshness(ageHours: number): number {
  // A posting dated in the future (clock skew, time zones) counts as brand new, never above it.
  return 0.5 ** (Math.max(0, ageHours) / 24);
}

// The queue's one ordering number. Fit (0–1) arrives with scoring (NS-116); until then it is
// null and the queue is freshness alone.
export function queueScore(fresh: number, fit: number | null): number {
  return fit === null ? fresh : fresh * fit;
}

// Age from when the board says it was posted, or when Northstar first saw it.
export function ageHours(postedAt: Date | null, firstSeenAt: Date, now: Date): number {
  return (now.getTime() - (postedAt ?? firstSeenAt).getTime()) / 3_600_000;
}
