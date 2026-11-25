import { checkSettings, DEFAULT_API_ORIGIN } from "./settings.js";

// The options page: the API's address and the extension token (NS-128). Both live in
// chrome.storage.local on Paul's machine only.

const form = document.getElementById("options") as HTMLFormElement;
const apiOrigin = document.getElementById("apiOrigin") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status") as HTMLParagraphElement;

void chrome.storage.local.get(["apiOrigin", "token"]).then((stored) => {
  apiOrigin.value = String(stored.apiOrigin ?? DEFAULT_API_ORIGIN);
  // The token is never shown again once saved; an empty field keeps the stored one.
  token.placeholder = stored.token ? "Saved. Paste a new one to replace it." : "Extension token";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const stored = await chrome.storage.local.get(["token"]);
    const checked = checkSettings({
      apiOrigin: apiOrigin.value,
      token: token.value || String(stored.token ?? ""),
    });
    if (!checked.ok) {
      status.textContent = checked.message;
      return;
    }
    await chrome.storage.local.set(checked.settings);
    token.value = "";
    token.placeholder = "Saved. Paste a new one to replace it.";
    status.textContent = "Saved.";
  })();
});
