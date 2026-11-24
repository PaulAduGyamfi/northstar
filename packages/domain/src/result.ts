// Expected outcomes (an illegal move, a stale status) are values, not exceptions, so callers
// must handle them and the type checker shows which ones can happen.
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
