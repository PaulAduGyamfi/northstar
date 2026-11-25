import { describe, expect, it } from "vitest";
import {
  createSessions,
  keyMatches,
  SESSION_TTL_MS,
  THROTTLE_LIMIT,
  THROTTLE_WINDOW_MS,
} from "./sessions.js";

const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("keyMatches", () => {
  it("accepts the key whose SHA-256 is configured", () => {
    expect(keyMatches("test-key", HASH)).toBe(true);
  });

  it("refuses any other key", () => {
    expect(keyMatches("test-key ", HASH)).toBe(false);
  });
});

describe("sessions", () => {
  it("a session opened is live until it expires", () => {
    const c = clock();
    const s = createSessions(c.now);
    const { token } = s.open();
    expect(s.isLive(token)).toBe(true);
    c.advance(SESSION_TTL_MS);
    expect(s.isLive(token)).toBe(false);
  });

  it("a closed session is no longer live", () => {
    const s = createSessions(() => 0);
    const { token } = s.open();
    s.close(token);
    expect(s.isLive(token)).toBe(false);
  });

  it("a token that was never opened is not live", () => {
    const s = createSessions(() => 0);
    s.open();
    expect(s.isLive("A".repeat(43))).toBe(false);
  });

  it("each session gets its own 32-byte token", () => {
    const s = createSessions(() => 0);
    const a = s.open().token;
    const b = s.open().token;
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("five failures in a minute throttle sign-in until the minute is up", () => {
    const c = clock();
    const s = createSessions(c.now);
    for (let i = 0; i < THROTTLE_LIMIT; i++) s.recordFailure();
    expect(s.throttled()).toBe(true);
    c.advance(THROTTLE_WINDOW_MS);
    expect(s.throttled()).toBe(false);
  });

  it("four failures don't throttle", () => {
    const s = createSessions(() => 0);
    for (let i = 0; i < THROTTLE_LIMIT - 1; i++) s.recordFailure();
    expect(s.throttled()).toBe(false);
  });
});
