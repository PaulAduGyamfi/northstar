import { captureRequest, type Page, pageCapture, resultMessage } from "./capture.js";
import { type FillResult, fillForm } from "./prefill.js";
import { runPrefill } from "./prefill-run.js";
import { checkSettings, DEFAULT_API_ORIGIN } from "./settings.js";

// The popup's "Save to Northstar" button (NS-128). Nothing runs until Paul clicks it; then
// activeTab lets this read the one page he is looking at, once.

// Runs inside the page. Chrome serialises it, so it must use nothing from this module.
function readPage(): Page {
  // biome-ignore lint/performance/useDomNodeTextContent: innerText is the text Paul sees; textContent would add hidden elements and script contents.
  const text = document.body?.innerText ?? "";
  return { url: location.href, title: document.title, text };
}

const button = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const show = (message: string) => {
  status.textContent = message;
};

async function readSettings() {
  const stored = await chrome.storage.local.get(["apiOrigin", "token"]);
  return checkSettings({
    apiOrigin: String(stored.apiOrigin ?? DEFAULT_API_ORIGIN),
    token: String(stored.token ?? ""),
  });
}

async function save(): Promise<void> {
  const checked = await readSettings();
  if (!checked.ok) return show(`${checked.message} Open the extension's options.`);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return show("There is no page to save.");
  let page: Page | null = null;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPage,
    });
    page = injected?.result ? pageCapture(injected.result) : null;
  } catch {
    // Chrome refuses its own pages and the Web Store; nothing is read there.
  }
  if (page === null) return show("This page can't be saved.");

  const { url, init } = captureRequest(checked.settings, page);
  try {
    const res = await fetch(url, init);
    show(resultMessage(res.status, await res.json().catch(() => null)));
  } catch {
    show(resultMessage(0, null));
  }
}

button.addEventListener("click", () => {
  button.disabled = true;
  show("Saving…");
  void save().finally(() => {
    button.disabled = false;
  });
});

// "Fill this form" (NS-192 slice 4, ADR-0030): the pasted code goes to runPrefill and is cleared
// from the field at once. It lives only in this popup's memory, never in storage or a URL.
const codeInput = document.getElementById("code") as HTMLInputElement;
const fillButton = document.getElementById("fill") as HTMLButtonElement;
const fillStatus = document.getElementById("fill-status") as HTMLParagraphElement;

fillButton.addEventListener("click", () => {
  const code = codeInput.value;
  codeInput.value = "";
  fillButton.disabled = true;
  fillStatus.textContent = "Filling…";
  void runPrefill(code, {
    settings: readSettings,
    fetch: (url, init) => fetch(url, init),
    activeTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
    inject: async (tabId, fills, at) => {
      // The tab's main frame only: an embedded frame never receives Paul's details.
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: fillForm,
        args: [fills, null, at],
      });
      return (injected?.result as FillResult | undefined) ?? null;
    },
  })
    .then((message) => {
      fillStatus.textContent = message;
    })
    // runPrefill answers every refusal itself; this is the last word if Chrome throws anyway.
    .catch(() => {
      fillStatus.textContent = "Northstar couldn't pre-fill this form.";
    })
    .finally(() => {
      fillButton.disabled = false;
    });
});
