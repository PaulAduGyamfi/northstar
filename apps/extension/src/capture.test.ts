import { describe, expect, it } from "vitest";
import { captureRequest, pageCapture, resultMessage } from "./capture.js";
import { checkSettings } from "./settings.js";

// The extension's plain logic. Synthetic pages and tokens only; nothing calls the network.
const SETTINGS = { apiOrigin: "http://127.0.0.1:8787", token: "test-extension-token" };

describe("pageCapture", () => {
  it("keeps the URL and title and trims the text", () => {
    expect(
      pageCapture({ url: "https://jobs.example.com/1", title: " Engineer ", text: "  Hiring  " }),
    ).toEqual({ url: "https://jobs.example.com/1", title: "Engineer", text: "Hiring" });
  });

  it("cuts the text at 20,000 characters, the API's limit", () => {
    const c = pageCapture({
      url: "https://jobs.example.com/1",
      title: "",
      text: "x".repeat(25_000),
    });
    expect(c?.text).toHaveLength(20_000);
  });

  it("drops a title over 500 characters rather than sending one the API refuses", () => {
    const c = pageCapture({ url: "https://jobs.example.com/1", title: "t".repeat(501), text: "x" });
    expect(c?.title).toBe("");
  });

  it("captures nothing from a page that isn't http(s), such as the browser's own pages", () => {
    expect(pageCapture({ url: "chrome://settings", title: "Settings", text: "x" })).toBeNull();
  });

  it("captures nothing from a URL over 2,048 characters, which the API would refuse", () => {
    const url = `https://jobs.example.com/1?${"t".repeat(2048)}`;
    expect(pageCapture({ url, title: "x", text: "Hiring" })).toBeNull();
  });

  it("captures nothing from a page with no text", () => {
    expect(pageCapture({ url: "https://jobs.example.com/1", title: "x", text: "   " })).toBeNull();
  });
});

describe("captureRequest", () => {
  it("posts JSON to the API's /jobs/capture with the extension token", () => {
    const capture = { url: "https://jobs.example.com/1", title: "Engineer", text: "Hiring" };
    const { url, init } = captureRequest(SETTINGS, capture);
    expect(url).toBe("http://127.0.0.1:8787/jobs/capture");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-extension-token",
    });
    expect(JSON.parse(String(init.body))).toEqual(capture);
  });
});

describe("resultMessage", () => {
  const ok = (body: object) => resultMessage(200, { jobId: "job-1", reason: null, ...body });

  it("names the fields found for a new job", () => {
    expect(ok({ status: "created", found: ["title", "company"], missing: ["salary"] })).toBe(
      "Saved to Northstar. Found: title, company. Missing: salary.",
    );
  });

  it("says a page that adds a source to a known job was saved there", () => {
    expect(ok({ status: "merged", found: [], missing: [] })).toBe(
      "Saved: added as another source for a job already in Northstar.",
    );
  });

  it("says a known posting is already saved", () => {
    expect(ok({ status: "unchanged", found: [], missing: [] })).toBe("Already in Northstar.");
  });

  it("gives the reason for a refusal", () => {
    expect(
      ok({ status: "refused", reason: "not a valid link", found: [], missing: [], jobId: null }),
    ).toBe("Not saved: not a valid link.");
  });

  it("says when the page held no posting", () => {
    expect(ok({ status: "not_a_job", found: [], missing: [], jobId: null })).toBe(
      "Not saved: Northstar couldn't find a job posting on this page.",
    );
  });

  it("suggests a retry when reading failed", () => {
    expect(
      ok({ status: "failed", reason: "the site didn't answer in time", found: [], missing: [] }),
    ).toBe("Not saved: the site didn't answer in time. Try again in a minute.");
  });

  it("points to the options when the token is refused", () => {
    expect(resultMessage(401, { error: "unauthenticated" })).toBe(
      "Northstar didn't accept the extension token. Check it in the extension's options.",
    );
  });

  it("says Northstar hit an error on a server error, not that it is down", () => {
    expect(resultMessage(500, { error: "internal" })).toBe(
      "Northstar hit an error saving this page. Try again, or check the API's log.",
    );
  });

  it("says the extension is out of date when the API refuses the request's shape", () => {
    expect(resultMessage(400, { error: "invalid_input" })).toBe(
      "Northstar refused this request (400). Rebuild and reload the extension.",
    );
  });

  it("asks to wait after too many wrong tokens", () => {
    expect(resultMessage(429, { error: "throttled" })).toBe(
      "Too many wrong tokens. Wait a minute, then check the token in the options.",
    );
  });

  it("says Northstar is unreachable when there was no answer", () => {
    expect(resultMessage(0, null)).toBe("Couldn't reach Northstar. Is the API running?");
  });
});

describe("checkSettings", () => {
  it("accepts the local API and a token", () => {
    expect(checkSettings(SETTINGS)).toEqual({ ok: true, settings: SETTINGS });
  });

  it("refuses an API origin that isn't 127.0.0.1, so the token never leaves the machine", () => {
    expect(checkSettings({ ...SETTINGS, apiOrigin: "https://api.example.com" })).toEqual({
      ok: false,
      message: "The API address must be http://127.0.0.1:<port>.",
    });
  });

  it("refuses an empty token", () => {
    expect(checkSettings({ ...SETTINGS, token: " " })).toEqual({
      ok: false,
      message: "Paste the extension token first.",
    });
  });
});
