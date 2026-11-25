import { captureRequest, type Page, pageCapture, resultMessage } from "./capture.js";
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

async function save(): Promise<void> {
  const stored = await chrome.storage.local.get(["apiOrigin", "token"]);
  const checked = checkSettings({
    apiOrigin: String(stored.apiOrigin ?? DEFAULT_API_ORIGIN),
    token: String(stored.token ?? ""),
  });
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
