import { describe, expect, it } from "vitest";
import { extractVerification, htmlToText } from "./extract.js";

// Synthetic verification mails (the repo is public): invented companies, example.com hosts.

describe("extractVerification: codes", () => {
  it("finds a digit code on the line that says it is a code", () => {
    const text = "Hi Sam,\n\nYour verification code is 482913.\nIt expires in 10 minutes.";
    expect(extractVerification(text, null)).toEqual({ codes: ["482913"], links: [] });
  });

  it("finds a code on the line after the one that announces it", () => {
    const text = "Use this one-time passcode to continue:\n\n  73K9QZ\n\nThanks, Acme Careers";
    expect(extractVerification(text, null).codes).toEqual(["73K9QZ"]);
  });

  it("ignores numbers on lines that don't talk about a code", () => {
    const text = "Your code is below.\n\n© 2026 Acme Corp, 1200 Example Ave, Suite 4100";
    expect(extractVerification(text, null).codes).toEqual([]);
  });

  it("ignores words in capitals that have no digit, and numbers outside 4 to 8 characters", () => {
    const text = "Your OTP CODE: valid for 15 minutes. Reference 123456789.";
    expect(extractVerification(text, null).codes).toEqual([]);
  });

  it("finds a code inside HTML once tags are removed", () => {
    const html =
      "<html><body><p>Your security code:</p><div style='font-size:24px'><b>5917</b></div></body></html>";
    expect(extractVerification("", html).codes).toEqual(["5917"]);
  });

  it("returns each distinct code once when the mail repeats it", () => {
    const text = "Your code is 482913.";
    const html = "<p>Your code is <strong>482913</strong></p>";
    expect(extractVerification(text, html).codes).toEqual(["482913"]);
  });

  it("returns every distinct code so the caller can see the mail is ambiguous", () => {
    const text = "Your code is 482913.\nIgnore the old code 111222.";
    expect(extractVerification(text, null).codes).toEqual(["482913", "111222"]);
  });
});

describe("extractVerification: links", () => {
  it("finds a verification link in an HTML href, decoding &amp;", () => {
    const html =
      '<a href="https://acme.wd5.myworkdayjobs.com/verify?token=abc&amp;lang=en">Verify email</a>';
    expect(extractVerification("", html).links).toEqual([
      "https://acme.wd5.myworkdayjobs.com/verify?token=abc&lang=en",
    ]);
  });

  it("finds a link whose anchor text says what it does, whatever its path", () => {
    const html = '<a href="https://acme.example.com/l/9f8e7d">Confirm your account</a>';
    expect(extractVerification("", html).links).toEqual(["https://acme.example.com/l/9f8e7d"]);
  });

  it("finds a verification link in plain text, without trailing punctuation", () => {
    const text = "Activate your account here: https://jobs.example.com/activate/abc123.";
    expect(extractVerification(text, null).links).toEqual([
      "https://jobs.example.com/activate/abc123",
    ]);
  });

  it("keeps an http link so the safety check can refuse it rather than skip it", () => {
    const text = "Verify: http://jobs.example.com/verify/abc";
    expect(extractVerification(text, null).links).toEqual(["http://jobs.example.com/verify/abc"]);
  });

  it("skips links that aren't about verifying, like privacy and unsubscribe links", () => {
    const html =
      '<a href="https://acme.example.com/privacy">Privacy</a> <a href="https://acme.example.com/unsubscribe">Unsubscribe</a>';
    expect(extractVerification("", html).links).toEqual([]);
  });

  it("lists the same link once when the text and the HTML both carry it", () => {
    const text = "Verify: https://jobs.example.com/verify/abc";
    const html = '<a href="https://jobs.example.com/verify/abc">Verify</a>';
    expect(extractVerification(text, html).links).toEqual(["https://jobs.example.com/verify/abc"]);
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, breaks lines at blocks and decodes entities", () => {
    expect(
      htmlToText(
        "<style>p{color:red}</style><p>Code&nbsp;below</p><div>1&#50;34 &amp; more</div><script>x=1</script>",
      ),
    ).toBe("Code below\n1234 & more");
  });
});
