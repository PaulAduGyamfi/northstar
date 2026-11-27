import type { DomDocument } from "../browser/collect.js";
import { doc, el, type FakeElement } from "../browser/test/dom.js";

// RECORDED form structures (NS-142 slice 2, #76), fetched 2026-11-27 with plain GET requests of
// public application pages. Only the form's STRUCTURE is kept: each control's tag, type, name, id,
// role and required flag, the buttons and the CAPTCHA widget. Everything else is synthetic: no
// posting text, company, person, email, phone or label a company wrote. Company-specific ids
// (Greenhouse question numbers, Lever card UUIDs) are replaced with synthetic ones of the same
// shape, and a form's repeated custom questions are cut to one of each kind. Labels are kept only
// where the ATS itself writes them ("First Name"). What these showed the driver can't do yet is
// #353 (NS-255).

export type RecordedControl = {
  tag: "input" | "select" | "textarea" | "button";
  type?: string;
  name?: string;
  id?: string;
  // `combobox` for a react-select dropdown: an input, not a native select.
  role?: string;
  required: boolean;
  // Hidden from sight by a class (Greenhouse's file inputs, Lever's hCaptcha submit).
  hiddenByClass?: boolean;
  // A radio's or checkbox's label (synthetic), or an ATS-written label.
  label?: string;
};

export type RecordedForm = {
  // Host and path shape only, never the real company's board name.
  source: { host: string; path: string; fetched: string };
  formAttrs: Record<string, string>;
  controls: RecordedControl[];
  // CAPTCHA widgets on the page, outside the form, with the attributes `collectPage` reads.
  captcha: Record<string, string>[];
};

// The keys an adapter can fill a recorded control by: its name, else its id (Greenhouse's new
// board has no names; #353).
export const controlKey = (c: RecordedControl): string | undefined => c.name ?? c.id;

export const RECORDED: { greenhouse: RecordedForm; lever: RecordedForm } = {
  // job-boards.greenhouse.io (boards.greenhouse.io redirects here). Server-rendered React (Remix):
  // ids, no names; dropdowns are react-select comboboxes with a required stand-in input after each
  // required one.
  greenhouse: {
    source: { host: "job-boards.greenhouse.io", path: "/<board>/jobs/<id>", fetched: "2026-11-27" },
    formAttrs: { id: "application-form", method: "get", action: "/examplecorp/jobs/4001" },
    controls: [
      { tag: "input", type: "text", id: "first_name", required: true, label: "First Name" },
      { tag: "input", type: "text", id: "last_name", required: true, label: "Last Name" },
      { tag: "input", type: "text", id: "email", required: true, label: "Email" },
      { tag: "input", type: "text", id: "country", role: "combobox", required: false },
      { tag: "button", type: "button", required: false },
      { tag: "input", type: "tel", id: "phone", required: false, label: "Phone" },
      { tag: "input", type: "file", id: "resume", required: false, hiddenByClass: true },
      { tag: "input", type: "file", id: "cover_letter", required: false, hiddenByClass: true },
      { tag: "input", type: "text", id: "question_1001", required: false },
      { tag: "input", type: "text", id: "question_1002", role: "combobox", required: true },
      { tag: "input", required: true },
      { tag: "input", type: "text", id: "gender", role: "combobox", required: false },
      { tag: "input", type: "text", id: "hispanic_ethnicity", role: "combobox", required: false },
      { tag: "input", type: "text", id: "veteran_status", role: "combobox", required: false },
      { tag: "button", type: "submit", required: false },
    ],
    captcha: [],
  },
  // jobs.lever.co/<company>/<posting uuid>/apply. Server-rendered with names. hCaptcha is set to
  // invisible by script, not by a data-size attribute, and its submit button is the form's only
  // type=submit; the visible "Submit application" is a type=button.
  lever: {
    source: {
      host: "jobs.lever.co",
      path: "/<company>/<posting uuid>/apply",
      fetched: "2026-11-27",
    },
    formAttrs: { id: "application-form", method: "POST", enctype: "multipart/form-data" },
    controls: [
      { tag: "input", type: "file", name: "resume", id: "resume-upload-input", required: false },
      { tag: "input", type: "text", name: "name", required: true },
      { tag: "input", type: "email", name: "email", required: true },
      { tag: "input", type: "text", name: "phone", required: false },
      { tag: "input", type: "text", name: "location", id: "location-input", required: true },
      { tag: "input", type: "hidden", name: "selectedLocation", required: false },
      { tag: "input", type: "text", name: "org", required: false },
      { tag: "input", type: "text", name: "urls[LinkedIn]", required: false },
      { tag: "input", type: "text", name: "urls[GitHub]", required: false },
      { tag: "input", type: "text", name: "urls[Portfolio]", required: false },
      { tag: "input", type: "hidden", name: CARD("baseTemplate"), required: false },
      { tag: "input", type: "checkbox", name: CARD("field0"), required: false, label: "Option A" },
      { tag: "input", type: "checkbox", name: CARD("field0"), required: false, label: "Option B" },
      { tag: "input", type: "radio", name: CARD("field1"), required: true, label: "Yes" },
      { tag: "input", type: "radio", name: CARD("field1"), required: true, label: "No" },
      { tag: "textarea", name: CARD("field2"), required: false },
      { tag: "textarea", name: "comments", id: "additional-information", required: false },
      { tag: "input", type: "hidden", name: "h-captcha-response", required: false },
      {
        tag: "button",
        type: "submit",
        id: "hcaptchaSubmitBtn",
        required: false,
        hiddenByClass: true,
      },
      { tag: "button", type: "button", id: "btn-submit", required: false },
    ],
    captcha: [{ class: "h-captcha", id: "h-captcha" }],
  },
};

// A synthetic Lever card field name, in Lever's `cards[<uuid>][<field>]` shape.
function CARD(field: string): string {
  return `cards[00000000-0000-4000-8000-00000000c0de][${field}]`;
}

// A recording as a page in the stand-in DOM, so the driver's own in-page code reads it.
export function recordedPage(r: RecordedForm): DomDocument {
  const controls: FakeElement[] = r.controls.map((c) => {
    const attrs: Record<string, string> = {};
    if (c.type !== undefined) attrs.type = c.type;
    if (c.name !== undefined) attrs.name = c.name;
    if (c.id !== undefined) attrs.id = c.id;
    if (c.role !== undefined) attrs.role = c.role;
    if (c.required) attrs.required = "";
    if (c.hiddenByClass) attrs.class = "hidden";
    return el(c.tag, attrs, c.label === undefined ? {} : { label: c.label });
  });
  return doc([controls], { others: r.captcha.map((a) => el("div", a)) });
}
