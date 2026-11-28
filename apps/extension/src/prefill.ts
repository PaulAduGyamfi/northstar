import type { Settings } from "./settings.js";

// The handoff pre-fill's plain logic (NS-192 slice 3, ADR-0029, APPLY-006): which fields the
// extension may fill on which page, the in-page fill, and the package request. The popup's
// "Fill this form" runs it with the code Paul pasted (prefill-run.ts, slice 4, ADR-0030). It fills
// only, never submits or touches the challenge (ADR-0003), and reports counts, never a value.

export type PrefillAts = "greenhouse" | "lever" | "ashby" | "smartrecruiters";

// The package `POST /handoffs/package` serves (apps/api/src/prefill.ts).
export type PrefillPackage = {
  handoffId: string;
  applicationId: string;
  ats: PrefillAts;
  applyUrl: string;
  contact: { firstName: string; lastName: string; email: string; phone: string | null };
  fields: Record<string, string | string[]>;
};

export type Fill = { name: string; value: string | string[] };

type Contact = PrefillPackage["contact"];

// Each ATS's own hosts and standard contact fields. This mirrors the Apply Gateway's adapters
// (packages/gateways/src/apply/adapters/), which the extension can't import (no bundler, and the
// gateway pulls in Node and the database): keep the two in step. Exported only for the parity test
// in packages/gateways (apply/prefill-parity.test.ts), which compares it with the gateway's.
export const ADAPTERS: Record<
  PrefillAts,
  { hosts: readonly string[]; standard: (c: Contact) => Record<string, string>; files: string[] }
> = {
  greenhouse: {
    hosts: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
    standard: (c) => ({
      first_name: c.firstName,
      last_name: c.lastName,
      email: c.email,
      ...(c.phone === null ? {} : { phone: c.phone }),
    }),
    files: ["resume", "cover_letter"],
  },
  lever: {
    hosts: ["jobs.lever.co"],
    standard: (c) => ({
      name: `${c.firstName} ${c.lastName}`,
      email: c.email,
      ...(c.phone === null ? {} : { phone: c.phone }),
    }),
    files: ["resume"],
  },
  ashby: {
    hosts: ["jobs.ashbyhq.com"],
    standard: (c) => ({
      _systemfield_name: `${c.firstName} ${c.lastName}`,
      _systemfield_email: c.email,
    }),
    files: ["_systemfield_resume"],
  },
  smartrecruiters: {
    hosts: ["jobs.smartrecruiters.com"],
    standard: (c) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      ...(c.phone === null ? {} : { phoneNumber: c.phone }),
    }),
    files: ["resume", "coverLetter"],
  },
};

export type PlanRefusal = "not_https" | "wrong_host" | "wrong_page" | "form_changed";

// Only a plain https URL: no port, no user name or password (the gateway's hostAllowed rule).
function plainHttps(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

// The path without a trailing slash, so ".../jobs/123/" and ".../jobs/123" are one page.
const pathOf = (url: URL) => url.pathname.replace(/\/+$/, "");

// What the extension may fill on the tab Paul is on, or why it fills nothing.
export function prefillPlan(
  pkg: PrefillPackage,
  tabUrl: string,
): { ok: true; fills: Fill[] } | { ok: false; refusal: PlanRefusal } {
  const adapter = ADAPTERS[pkg.ats];
  const tab = plainHttps(tabUrl);
  const apply = plainHttps(pkg.applyUrl);
  if (!adapter || tab === null || apply === null) return { ok: false, refusal: "not_https" };
  // An exact host from the ATS's own list: a lookalike or a subdomain is another site.
  if (!adapter.hosts.includes(tab.hostname)) return { ok: false, refusal: "wrong_host" };
  if (tab.hostname !== apply.hostname || pathOf(tab) !== pathOf(apply)) {
    return { ok: false, refusal: "wrong_page" };
  }
  const standard = adapter.standard(pkg.contact);
  // A package field may not take over a contact or file field (the gateway's mapPackage rule),
  // and a name with a control character is no form's (the gateway's driver refuses it too).
  for (const name of Object.keys(pkg.fields)) {
    if (name in standard || adapter.files.includes(name) || /\p{Cc}/u.test(name)) {
      return { ok: false, refusal: "form_changed" };
    }
  }
  const fills: Fill[] = [
    ...Object.entries(standard).map(([name, value]) => ({ name, value })),
    ...Object.entries(pkg.fields).map(([name, value]) => ({ name, value })),
  ];
  return { ok: true, fills };
}

// The host and path fillForm re-checks inside the page: the tab's, as prefillPlan accepted it.
export function fillTarget(tabUrl: string): FillTarget | null {
  const tab = plainHttps(tabUrl);
  return tab === null ? null : { hostname: tab.hostname, path: pathOf(tab) };
}

// The part of the page fillForm touches, so tests can pass plain objects.
export type FillElement = {
  tagName: string;
  type?: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  offsetParent?: unknown;
  options?: ArrayLike<{ value: string; text: string; selected: boolean }>;
  multiple?: boolean;
  dispatchEvent(event: Event): boolean;
};
export type FillDocument = {
  querySelectorAll(selector: string): ArrayLike<FillElement>;
  location?: { href: string };
};
// `moved`: the page wasn't the planned one when the fill ran, so nothing was touched.
export type FillResult = { filled: number; skipped: number; moved?: true };
// The page the plan was made for: fillForm checks it again inside the page (NS-192 slice 4).
export type FillTarget = { hostname: string; path: string };

// Runs inside the page (Chrome serialises it, so it must use nothing from this module). For each
// fill, only elements with exactly that name, visible and enabled; never a button, file or hidden
// input; a select only to options it offers. Fires input and change, never clicks or submits.
// With `at`, the page's own URL must still be that host and path (the tab may have navigated
// between the popup's check and the injection); otherwise it touches nothing.
export function fillForm(
  fills: Fill[],
  doc: FillDocument | null = null,
  at: FillTarget | null = null,
) {
  const page = doc ?? (document as unknown as FillDocument);
  if (at !== null) {
    let here: URL | null = null;
    try {
      here = new URL(page.location?.href ?? "");
    } catch {
      here = null;
    }
    const herePath = here?.pathname.replace(/\/+$/, "");
    if (
      here === null ||
      here.protocol !== "https:" ||
      here.port !== "" ||
      here.hostname !== at.hostname ||
      herePath !== at.path
    ) {
      return { filled: 0, skipped: fills.length, moved: true } as FillResult;
    }
  }
  const NEVER = ["file", "hidden", "submit", "button", "image", "reset"];
  const result: FillResult = { filled: 0, skipped: 0 };
  const fire = (el: FillElement) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // Quotes and backslashes escaped, as the Apply Gateway's driver does.
  const selectorFor = (name: string) => `[name="${name.replace(/["\\]/g, "\\$&")}"]`;
  for (const fill of fills) {
    const values = Array.isArray(fill.value) ? fill.value : [fill.value];
    const els = Array.from(fill.name ? page.querySelectorAll(selectorFor(fill.name)) : []);
    const visible = (el: FillElement) => !el.disabled && !el.hidden && el.offsetParent !== null;
    const isChoice = (el: FillElement) =>
      el.tagName.toLowerCase() === "input" &&
      ["checkbox", "radio"].includes((el.type ?? "").toLowerCase());
    // A checkbox or radio group is touched only when one of its visible boxes carries a chosen
    // value; otherwise Paul's or the page's choice stays as it is and the fill counts as skipped.
    const choiceMatches = els.some(
      (el) => isChoice(el) && visible(el) && values.includes(el.value),
    );
    let done = false;
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const type = (el.type ?? "").toLowerCase();
      // Hidden by the page or not laid out (offsetParent null): Paul couldn't see it.
      if (el.disabled || el.hidden || el.offsetParent === null) continue;
      if (tag === "input" && (type === "checkbox" || type === "radio")) {
        if (!choiceMatches) continue;
        const on = values.includes(el.value);
        if (el.checked !== on) {
          el.checked = on;
          fire(el);
        }
        done = true;
      } else if (tag === "select") {
        const options = Array.from(el.options ?? []);
        const offered = (v: string) => options.some((o) => o.value === v || o.text === v);
        if (!values.every(offered) || (values.length > 1 && !el.multiple)) continue;
        for (const o of options) o.selected = values.includes(o.value) || values.includes(o.text);
        fire(el);
        done = true;
      } else if ((tag === "input" && !NEVER.includes(type)) || tag === "textarea") {
        if (values.length !== 1) continue;
        // Through the prototype's own setter, a safety net: where a shadowed `value` is visible
        // (a framework's tracker, as React installs, seen from the page's world) a plain
        // assignment would only reach the tracker. The popup injects into Chrome's isolated world,
        // where assignment already hits the native setter; the input event below is what tells
        // the page's framework.
        const proto = Object.getPrototypeOf(el) as object | null;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
        if (setter) setter.call(el, values[0] ?? "");
        else el.value = values[0] ?? "";
        fire(el);
        done = true;
      }
    }
    if (done) result.filled++;
    else result.skipped++;
  }
  return result;
}

// How long the popup waits for the package (RES-005): one database read and an event write.
export const PACKAGE_TIMEOUT_MS = 30_000;

// A signal that aborts after `ms` (plain setTimeout, so tests can use fake timers).
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
  return controller.signal;
}

// The read: the extension's own token and the one-time grant, sent once and never stored.
export function packageRequest(
  settings: Settings,
  handoffId: string,
  grant: string,
): { url: string; init: RequestInit } {
  return {
    url: `${settings.apiOrigin}/handoffs/package`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify({ handoffId, grant }),
      signal: timeoutSignal(PACKAGE_TIMEOUT_MS),
    },
  };
}

// One plain sentence for the read's answer or the plan's refusal.
const MESSAGES: Record<string, string> = {
  grant_invalid: "That pre-fill link has expired or was already used. Start again from Northstar.",
  not_found: "Northstar doesn't know that handoff.",
  closed: "That handoff is already closed.",
  no_package: "There is no approved package for that handoff.",
  not_approved: "The approval behind that package is no longer live.",
  changed: "The package changed after you approved it, so nothing was filled.",
  prefill_unrecorded: "Northstar couldn't record the pre-fill, so nothing was filled. Try again.",
  not_https: "This page isn't a secure application page, so nothing was filled.",
  wrong_host: "This tab isn't on the application's own site, so nothing was filled.",
  wrong_page: "This tab isn't the application's page, so nothing was filled.",
  form_changed: "The package doesn't fit this form, so nothing was filled.",
};

export function prefillMessage(code: string): string {
  return MESSAGES[code] ?? "Northstar couldn't pre-fill this form.";
}

// What Paul is told after a fill: counts only, and that submitting is his.
export function filledMessage(result: FillResult): string {
  const skipped = result.skipped === 0 ? "" : ` ${result.skipped} couldn't be filled.`;
  return `Filled ${result.filled} fields.${skipped} Check the form, then submit it yourself.`;
}
