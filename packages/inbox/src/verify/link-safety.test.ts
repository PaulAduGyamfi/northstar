import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { checkLink, checkRedirectChain } from "./link-safety.js";
import { VerificationSecret } from "./secret.js";

// Synthetic hosts only (the repo is public).
const HOSTS = ["acme.wd5.myworkdayjobs.com", "myworkday.com"];

describe("checkLink", () => {
  it("accepts an https link on an allowlisted host or a subdomain of one", () => {
    expect(checkLink("https://acme.wd5.myworkdayjobs.com/verify?t=abc", HOSTS)).toEqual({
      ok: true,
      href: "https://acme.wd5.myworkdayjobs.com/verify?t=abc",
    });
    expect(checkLink("https://Login.MyWorkday.com:443/activate/abc", HOSTS)).toEqual({
      ok: true,
      href: "https://login.myworkday.com/activate/abc",
    });
  });

  it("refuses a host that only looks like an allowlisted one", () => {
    for (const url of [
      "https://myworkday.com.evil.example/verify",
      "https://notmyworkday.com/verify",
      "https://evil.example/myworkday.com/verify",
    ]) {
      expect(checkLink(url, HOSTS)).toEqual({ ok: false, reason: "host_not_allowed" });
    }
  });

  it("refuses plain http even on an allowlisted host", () => {
    expect(checkLink("http://myworkday.com/verify", HOSTS)).toEqual({
      ok: false,
      reason: "not_https",
    });
  });

  it("refuses a link that carries a user name or password", () => {
    expect(checkLink("https://myworkday.com@evil.example/verify", HOSTS)).toEqual({
      ok: false,
      reason: "has_credentials",
    });
    expect(checkLink("https://user:pw@example.com/verify", HOSTS)).toEqual({
      ok: false,
      reason: "has_credentials",
    });
  });

  it("refuses an IP address host and a non-default port", () => {
    expect(checkLink("https://203.0.113.7/verify", HOSTS)).toEqual({
      ok: false,
      reason: "ip_host",
    });
    expect(checkLink("https://[2001:db8::1]/verify", HOSTS)).toEqual({
      ok: false,
      reason: "ip_host",
    });
    expect(checkLink("https://myworkday.com:8443/verify", HOSTS)).toEqual({
      ok: false,
      reason: "non_default_port",
    });
  });

  it("refuses a backslash, whitespace or control character that parsers read differently", () => {
    for (const url of [
      "https://acme.wd5.myworkdayjobs.com\\@evil.example/verify",
      "https://myworkday.com/ver ify",
      "https://myworkday.com/\tverify",
      "https://myworkday.com/verify\u0000",
    ]) {
      expect(checkLink(url, HOSTS)).toEqual({ ok: false, reason: "unsafe_characters" });
    }
  });

  it("refuses text that isn't a URL", () => {
    expect(checkLink("not-a-url", HOSTS)).toEqual({ ok: false, reason: "not_a_url" });
  });

  it("refuses everything when the window allows no link host", () => {
    expect(checkLink("https://myworkday.com/verify", [])).toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
  });
});

describe("checkRedirectChain", () => {
  it("accepts a chain whose every hop is allowed", () => {
    expect(
      checkRedirectChain(
        ["https://myworkday.com/v/abc", "https://acme.wd5.myworkdayjobs.com/done"],
        HOSTS,
      ),
    ).toEqual({ ok: true, href: "https://acme.wd5.myworkdayjobs.com/done" });
  });

  it("refuses a chain with one hop off the allowlist, even if it ends on an allowed host", () => {
    expect(
      checkRedirectChain(
        [
          "https://myworkday.com/v/abc",
          "https://tracker.evil.example/r",
          "https://acme.wd5.myworkdayjobs.com/done",
        ],
        HOSTS,
      ),
    ).toEqual({ ok: false, reason: "host_not_allowed" });
  });

  it("refuses an empty chain", () => {
    expect(checkRedirectChain([], HOSTS)).toEqual({ ok: false, reason: "not_a_url" });
  });
});

describe("VerificationSecret", () => {
  const secret = new VerificationSecret("482913");

  it("gives the value only through reveal", () => {
    expect(secret.reveal()).toBe("482913");
  });

  it("prints redacted when logged, stringified or serialized", () => {
    expect(String(secret)).toBe("[redacted]");
    expect(`${secret}`).toBe("[redacted]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(inspect({ secret }, { showHidden: true, depth: 5 })).toBe("{ secret: [redacted] }");
  });
});
