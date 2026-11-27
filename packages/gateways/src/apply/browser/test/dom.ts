import type { DomDocument, DomElement } from "../collect.js";

// A tiny stand-in for the browser's DOM (NS-142): just the members `collectPage` and
// `chooseOptions` touch, so their tests run in Node. Synthetic pages only.

export type FakeElement = DomElement & { attrs: Record<string, string>; clicks: number };

export function el(
  tag: string,
  attrs: Record<string, string> = {},
  extra: { options?: [string, string][]; label?: string; checked?: boolean } = {},
): FakeElement {
  const element: FakeElement = {
    tagName: tag.toUpperCase(),
    attrs,
    clicks: 0,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    ...(extra.options ? { options: extra.options.map(([value, text]) => ({ value, text })) } : {}),
    ...(extra.label === undefined ? {} : { labels: [{ textContent: extra.label }] }),
    checked: extra.checked ?? false,
    click() {
      element.clicks++;
      // A radio click unchecks its siblings in a real page; the tests only check the clicked one.
      element.checked = attrs.type === "radio" ? true : !element.checked;
    },
  };
  return element;
}

export function doc(
  forms: FakeElement[][],
  options: { others?: FakeElement[]; title?: string; text?: string } = {},
): DomDocument {
  const all = [...forms.flat(), ...(options.others ?? [])];
  return {
    title: options.title ?? "Apply",
    // A stand-in form's descendants are its elements; a test that needs them apart builds its own.
    forms: forms.map((elements) => ({
      elements,
      getElementsByTagName: (name: string) =>
        elements.filter((e) => e.tagName === name.toUpperCase()),
    })),
    getElementsByTagName: () => all,
    body: { textContent: options.text ?? "Apply for this job" },
  };
}

// The synthetic forms the adapters' fixtures describe (`../../test/fixtures.ts`), as pages.
export const GREENHOUSE_PAGE = (): DomDocument =>
  doc([
    [el("input", { name: "q", type: "search" })],
    [
      el("input", { name: "first_name", type: "text", required: "" }),
      el("input", { name: "last_name", type: "text", required: "" }),
      el("input", { name: "email", type: "email", required: "" }),
      el("input", { name: "phone", type: "tel" }),
      el("input", { name: "resume", type: "file", required: "" }),
      el("input", { name: "cover_letter", type: "file" }),
      el(
        "select",
        { name: "question_1001", required: "" },
        {
          options: [
            ["", "Please select"],
            ["1", "Yes"],
            ["0", "No"],
          ],
        },
      ),
      el("textarea", { name: "question_1002" }),
      el("input", { name: "authenticity_token", type: "hidden", required: "" }),
      el("button", { type: "submit" }),
    ],
  ]);

export const LEVER_PAGE = (): DomDocument =>
  doc([
    [
      el("input", { name: "name", required: "" }),
      el("input", { name: "email", type: "email", required: "" }),
      el("input", { name: "phone", type: "text" }),
      el("input", { name: "resume", type: "file", required: "" }),
      el("input", { name: "urls[LinkedIn]", type: "url" }),
      el(
        "input",
        { name: "cards[aaaa][field0]", type: "radio", value: "a", required: "" },
        { label: " Yes " },
      ),
      el("input", { name: "cards[aaaa][field0]", type: "radio", value: "b" }, { label: "No" }),
      el("button", {}),
    ],
  ]);

export const ASHBY_PAGE = (): DomDocument =>
  doc([
    [
      el("input", { name: "_systemfield_name", type: "text", "aria-required": "true" }),
      el("input", { name: "_systemfield_email", type: "email", "aria-required": "true" }),
      el("input", { name: "_systemfield_resume", type: "file", "aria-required": "true" }),
      el(
        "input",
        { name: "5f0c1e2a-0000-4000-8000-000000000001", type: "checkbox", required: "" },
        { label: "New York" },
      ),
      el(
        "input",
        { name: "5f0c1e2a-0000-4000-8000-000000000001", type: "checkbox" },
        { label: "Remote" },
      ),
      el("input", { type: "submit", value: "Submit Application" }),
    ],
  ]);
