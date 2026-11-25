// What the Apply Gateway needs from a browser (NS-120). The real driver (Playwright, its own
// worker pool, ADR-0007) is a follow-up; tests use a fake. A driver only reports what it sees:
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
  // An application form.
  | { kind: "form"; fields: readonly FormField[] }
  // Something only Paul's hands may get past.
  | { kind: "challenge"; challenge: Challenge }
  // Any other page, captured as proof material.
  | { kind: "page"; url: string; html: string; screenshotPng: Uint8Array };

export type Fill = { field: string; value: string | readonly string[] };
export type Upload = { field: string; fileName: string; bytes: Uint8Array };

// One browser session for one submission.
export interface FormDriver {
  open(url: string): Promise<PageState>;
  // Types the values, attaches the files, presses submit, and returns the page that follows.
  fillAndSubmit(fills: readonly Fill[], uploads: readonly Upload[]): Promise<PageState>;
  close(): Promise<void>;
}
