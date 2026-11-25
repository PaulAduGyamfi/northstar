import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Paul's sessions and the sign-in throttle (NS-156, ADR-0018). In memory on purpose: one user,
// one local API, so a restart signing Paul out is fine, and nothing about a session is stored.

// How long a session lasts (also the cookie's Max-Age).
export const SESSION_TTL_MS = 12 * 60 * 60_000;
// Wrong keys allowed per window before every sign-in is refused until the window passes.
export const THROTTLE_LIMIT = 5;
export const THROTTLE_WINDOW_MS = 60_000;

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

// Does this key hash to the configured SHA-256? Constant time, so timing says nothing.
export function keyMatches(key: string, expectedSha256Hex: string): boolean {
  return timingSafeEqual(sha256(key), Buffer.from(expectedSha256Hex, "hex"));
}

export type Sessions = ReturnType<typeof createSessions>;

export function createSessions(now: () => number) {
  // Session token hash (hex) -> expiry. The token itself lives only in Paul's cookie.
  const live = new Map<string, number>();
  let failures: number[] = [];
  const keyOf = (token: string) => sha256(token).toString("hex");

  return {
    open(): { token: string; expiresAt: number } {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + SESSION_TTL_MS;
      live.set(keyOf(token), expiresAt);
      return { token, expiresAt };
    },
    isLive(token: string): boolean {
      const key = keyOf(token);
      const expiresAt = live.get(key);
      if (expiresAt === undefined) return false;
      if (now() >= expiresAt) {
        live.delete(key);
        return false;
      }
      return true;
    },
    close(token: string): void {
      live.delete(keyOf(token));
    },
    recordFailure(): void {
      failures.push(now());
    },
    throttled(): boolean {
      const since = now() - THROTTLE_WINDOW_MS;
      failures = failures.filter((at) => at > since);
      return failures.length >= THROTTLE_LIMIT;
    },
  };
}
