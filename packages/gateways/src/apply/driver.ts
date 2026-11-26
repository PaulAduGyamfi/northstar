// What the Apply Gateway needs from a browser (NS-120). The real driver is Playwright's
// (`browser/driver.ts`, NS-142, ADR-0028), run in its own worker pool (ADR-0007); tests use a fake. A driver only reports what it sees:
// it never solves a CAPTCHA, signs in or creates an account (ADR-0003).

// One form field as the page shows it. `name` is the form's own field name.
export type FormField = {
  name: string;
  type: "text" | "email" | "tel" | "textarea" | "select" | "radio" | "checkbox" | "file" | "hidden";
  required: boolean;
  // The allowed values of a select, radio or checkbox group.
  options?: readonly string[];
};

export type Challenge = "captcha" | "login" | "mfa" | "account";

export type PageState =
  // An application form, and the URL it is on after any redirects.
  | { kind: "form"; url: string; fields: readonly FormField[] }
  // Something only Paul's hands may get past.
  | { kind: "challenge"; challenge: Challenge }
  // Any other page, captured as proof material.
  | { kind: "page"; url: string; html: string; screenshotPng: Uint8Array };

export type Fill = { field: string; value: string | readonly string[] };
export type Upload = { field: string; fileName: string; bytes: Uint8Array };

// One browser session for one submission. The gateway puts its own time limits around open and
// fillAndSubmit; a real driver should also refuse to navigate off the adapter's hosts.
export interface FormDriver {
  open(url: string): Promise<PageState>;
  // Types the values, attaches the files, presses submit, and returns the page that follows.
  fillAndSubmit(fills: readonly Fill[], uploads: readonly Upload[]): Promise<PageState>;
  // Ends the session and aborts any step still running: after a time limit the gateway calls
  // close, and a timed-out submit must not press the button later.
  close(): Promise<void>;
}
