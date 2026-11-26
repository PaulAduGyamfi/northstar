import type { Challenge, FormField } from "../driver.js";

// Reading an application page (NS-142). `collectPage` and `chooseOptions` run INSIDE the page
// (Playwright's `page.evaluate` sends their source), so each is one self-contained function: no
// imports, no helpers outside its own body. They are written against the small DOM shape below,
// so their tests run in Node on plain objects. `toFields` and `challengeOf` are plain code over
// what `collectPage` returns. The markers are hand-written and must be checked against recorded
// pages (the rest of #76).

// The few DOM members the in-page functions touch.
export type DomElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  // A select's options.
  options?: ArrayLike<{ text: string; value: string }>;
  // A radio's or checkbox's labels.
  labels?: ArrayLike<{ textContent: string | null }> | null;
  checked?: boolean;
  click?(): void;
};
export type DomForm = { elements: ArrayLike<DomElement> };
export type DomDocument = {
  title: string;
  forms: ArrayLike<DomForm>;
  getElementsByTagName(name: string): ArrayLike<DomElement>;
  body: { textContent: string | null } | null;
};

// The page's own `document` when the function runs in the browser. Tests pass a plain object.
declare const document: DomDocument;

// One named control of a form, as the page shows it.
export type RawControl = {
  tag: string;
  type: string;
  name: string;
  required: boolean;
  // A select's option labels, or a radio's / checkbox's own label.
  options: string[];
};

// What `challengeOf` decides from. Counts and flags only: never page text.
export type ChallengeSignals = {
  visibleCaptcha: boolean;
  cloudflareInterstitial: boolean;
  passwordFields: number;
  oneTimeCode: boolean;
  signUpWords: boolean;
};

export type CollectedPage = { forms: RawControl[][]; signals: ChallengeSignals };

// Runs in the page. `doc` is only for tests: in the browser it is undefined and `document` is used.
export function collectPage(_arg: null, doc?: DomDocument): CollectedPage {
  const d = doc ?? document;
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const forms: RawControl[][] = [];
  for (let f = 0; f < d.forms.length; f++) {
    const form = d.forms[f];
    if (!form) continue;
    const controls: RawControl[] = [];
    for (let i = 0; i < form.elements.length; i++) {
      const el = form.elements[i];
      if (!el) continue;
      const name = el.getAttribute("name");
      if (!name) continue;
      const tag = el.tagName.toLowerCase();
      const type = clean(el.getAttribute("type")).toLowerCase() || (tag === "input" ? "text" : tag);
      const options: string[] = [];
      if (tag === "select" && el.options) {
        for (let o = 0; o < el.options.length; o++) {
          const opt = el.options[o];
          // An empty value is the "Please select" placeholder, not a choice.
          if (opt && opt.value !== "") options.push(clean(opt.text));
        }
      } else if (type === "radio" || type === "checkbox") {
        const label = el.labels && el.labels.length > 0 ? el.labels[0]?.textContent : null;
        options.push(clean(label) || clean(el.getAttribute("value")));
      }
      controls.push({
        tag,
        type,
        name,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        options,
      });
    }
    forms.push(controls);
  }
  const all = d.getElementsByTagName("*");
  let visibleCaptcha = false;
  let cloudflareInterstitial = /^just a moment/i.test(clean(d.title));
  let passwordFields = 0;
  let oneTimeCode = false;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el) continue;
    const classes = ` ${clean(el.getAttribute("class"))} `;
    const invisible = el.getAttribute("data-size") === "invisible";
    // A widget Paul would have to solve. Invisible reCAPTCHA shows nothing to solve.
    if ((classes.includes(" g-recaptcha ") || classes.includes(" h-captcha ")) && !invisible) {
      visibleCaptcha = true;
    }
    if (classes.includes(" cf-turnstile ")) visibleCaptcha = true;
    const id = el.getAttribute("id") ?? "";
    if (id === "challenge-form" || id === "cf-challenge-running") cloudflareInterstitial = true;
    if (el.tagName.toLowerCase() === "input") {
      const type = clean(el.getAttribute("type")).toLowerCase();
      if (type === "password") passwordFields++;
      const key = `${el.getAttribute("name") ?? ""} ${id}`;
      if (
        el.getAttribute("autocomplete") === "one-time-code" ||
        /(^|[^a-z])(otp|mfa|2fa)([^a-z]|$)|one[-_ ]?time|verification[-_ ]?code/i.test(key)
      ) {
        oneTimeCode = true;
      }
    }
  }
  const text = clean(d.body?.textContent);
  const signUpWords = /create (an |your )?account|sign up|register/i.test(text);
  return {
    forms,
    signals: { visibleCaptcha, cloudflareInterstitial, passwordFields, oneTimeCode, signUpWords },
  };
}

// Runs in the page: in form `formIndex`, makes exactly the radios/checkboxes named `name` whose
// label is in `labels` checked (clicking, so the page's own handlers see it), and the rest
// unchecked. Returns how many of `labels` it found. `doc` is only for tests.
export function chooseOptions(
  arg: { formIndex: number; name: string; labels: string[] },
  doc?: DomDocument,
): number {
  const d = doc ?? document;
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const form = d.forms[arg.formIndex];
  if (!form) return 0;
  let found = 0;
  for (let i = 0; i < form.elements.length; i++) {
    const el = form.elements[i];
    if (!el || el.getAttribute("name") !== arg.name) continue;
    const label = el.labels && el.labels.length > 0 ? el.labels[0]?.textContent : null;
    const text = clean(label) || clean(el.getAttribute("value"));
    const want = arg.labels.includes(text);
    if (want) found++;
    if (Boolean(el.checked) !== want && el.click) el.click();
  }
  return found;
}

// Limits on what a page may report. Real application forms are far smaller; a page past them is
// refused instead of filling the worker's memory.
export const COLLECT_LIMITS = { forms: 50, controls: 500, options: 200, chars: 1000 } as const;

class CollectedError extends Error {
  override name = "DriverError";
}

// `collectPage` runs beside the page's own script, which can redefine the DOM members it reads,
// so its answer is checked here in Node: the exact shape, strings and booleans only, and the
// limits above. Anything else throws (a `driver_error` handoff in the gateway).
export function checkCollected(value: unknown): CollectedPage {
  const fail = (what: string): never => {
    throw new CollectedError(`the page reported ${what}`);
  };
  const str = (v: unknown): string =>
    typeof v === "string" && v.length <= COLLECT_LIMITS.chars ? v : fail("a bad string");
  const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail("a bad flag"));
  const list = (v: unknown, max: number): unknown[] =>
    Array.isArray(v) && v.length <= max ? v : fail("a bad list");
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : fail("a bad object");
  const page = obj(value);
  const signals = obj(page.signals);
  const passwordFields = signals.passwordFields;
  if (
    typeof passwordFields !== "number" ||
    !Number.isInteger(passwordFields) ||
    passwordFields < 0
  ) {
    fail("a bad count");
  }
  let controls = 0;
  const forms = list(page.forms, COLLECT_LIMITS.forms).map((form) =>
    list(form, COLLECT_LIMITS.controls).map((raw): RawControl => {
      controls++;
      if (controls > COLLECT_LIMITS.controls) fail("too many controls");
      const c = obj(raw);
      return {
        tag: str(c.tag),
        type: str(c.type),
        name: str(c.name),
        required: bool(c.required),
        options: list(c.options, COLLECT_LIMITS.options).map(str),
      };
    }),
  );
  return {
    forms,
    signals: {
      visibleCaptcha: bool(signals.visibleCaptcha),
      cloudflareInterstitial: bool(signals.cloudflareInterstitial),
      passwordFields: passwordFields as number,
      oneTimeCode: bool(signals.oneTimeCode),
      signUpWords: bool(signals.signUpWords),
    },
  };
}

// Input types that read as plain text to the adapters.
const TEXT_TYPES = new Set(["text", "url", "number", "date", "search", "month", "week", "time"]);
const KEPT_TYPES = new Set(["email", "tel", "file", "hidden"]);

// Controls → the gateway's FormFields: a radio or checkbox group is one field with every label as
// an option; buttons, passwords and anything else unknown are left out.
export function toFields(controls: readonly RawControl[]): FormField[] {
  const fields: FormField[] = [];
  const groups = new Map<string, FormField & { options: string[] }>();
  for (const c of controls) {
    if (c.tag === "select") {
      fields.push({ name: c.name, type: "select", required: c.required, options: [...c.options] });
    } else if (c.tag === "textarea") {
      fields.push({ name: c.name, type: "textarea", required: c.required });
    } else if (c.tag === "input" && (c.type === "radio" || c.type === "checkbox")) {
      const group = groups.get(c.name);
      if (group && group.type === c.type) {
        group.options.push(...c.options);
        group.required = group.required || c.required;
      } else if (!group) {
        const field = {
          name: c.name,
          type: c.type as "radio" | "checkbox",
          required: c.required,
          options: [...c.options],
        };
        groups.set(c.name, field);
        fields.push(field);
      }
    } else if (c.tag === "input" && TEXT_TYPES.has(c.type)) {
      fields.push({ name: c.name, type: "text", required: c.required });
    } else if (c.tag === "input" && KEPT_TYPES.has(c.type)) {
      fields.push({ name: c.name, type: c.type as FormField["type"], required: c.required });
    }
  }
  return fields;
}

// Something only Paul's hands may get past (ADR-0003), or null. Never solved, never worked around.
export function challengeOf(s: ChallengeSignals): Challenge | null {
  if (s.visibleCaptcha || s.cloudflareInterstitial) return "captcha";
  if (s.oneTimeCode) return "mfa";
  if (s.passwordFields >= 2 || (s.passwordFields === 1 && s.signUpWords)) return "account";
  if (s.passwordFields === 1) return "login";
  return null;
}

// The form to fill: the one with the most fields (an ATS page may also carry a search or
// newsletter form). Null when the page has none.
export function pickForm(
  forms: readonly RawControl[][],
): { index: number; fields: FormField[] } | null {
  let best: { index: number; fields: FormField[] } | null = null;
  for (const [index, controls] of forms.entries()) {
    const fields = toFields(controls);
    if (fields.length > 0 && (best === null || fields.length > best.fields.length)) {
      best = { index, fields };
    }
  }
  return best;
}
