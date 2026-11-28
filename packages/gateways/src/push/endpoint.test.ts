import { describe, expect, it } from "vitest";
import { endpointAllowed } from "./endpoint.js";

// An endpoint carrying credentials, built with URL so no address-shaped literal sits in the file.
function withUserInfo(endpoint: string): string {
  const url = new URL(endpoint);
  url.username = "user";
  url.password = "secret-for-test";
  return url.href;
}

describe("endpointAllowed (NS-193, ADR-0032 item 3)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc123:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
  ])("allows a known push service: %s", (endpoint) => {
    expect(endpointAllowed(endpoint)).toBe(true);
  });

  it.each([
    ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["another host", "https://example.com/push"],
    ["a subdomain of FCM", "https://x.fcm.googleapis.com/fcm/send/abc"],
    ["another Apple host", "https://api.push.apple.com/3/device/abc"],
    ["the bare Windows name", "https://notify.windows.com/w/?token=B"],
    ["a lookalike Windows suffix", "https://evilnotify.windows.com/w/?token=B"],
    ["a lookalike suffix", "https://evilfcm.googleapis.com.example.com/x"],
    ["a host that only ends with the name", "https://notfcm.googleapis.com/x"],
    ["a non-default port", "https://fcm.googleapis.com:8443/fcm/send/abc"],
    ["user info", withUserInfo("https://fcm.googleapis.com/fcm/send/abc")],
    ["an IPv4 literal", "https://127.0.0.1/push"],
    ["an IPv6 literal", "https://[::1]/push"],
    ["a trailing-dot host", "https://fcm.googleapis.com./fcm/send/abc"],
    ["a fragment", "https://fcm.googleapis.com/fcm/send/abc#x"],
    ["not a URL", "fcm.googleapis.com/fcm/send/abc"],
    ["a data URL", "data:text/plain,hi"],
    ["an endpoint over 1024 characters", `https://fcm.googleapis.com/${"a".repeat(1024)}`],
  ])("refuses %s", (_, endpoint) => {
    expect(endpointAllowed(endpoint)).toBe(false);
  });
});
