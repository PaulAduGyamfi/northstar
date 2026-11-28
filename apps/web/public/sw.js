// Northstar's service worker (NS-193 slice 2, ADR-0032 item 4). It shows a push's fixed words and
// opens Today when Paul taps it. Nothing else: no caching, no fetch handling, no action on Paul's
// behalf. A push carries codes only ({ v, kind, id, ats, reason }); the words below are a copy of
// pushWords in packages/domain (push-payload.ts), and a test there checks they agree.

const ATS_FORM = {
  greenhouse: "A Greenhouse form",
  lever: "A Lever form",
  ashby: "An Ashby form",
  smartrecruiters: "A Smartrecruiters form",
};
const CHALLENGE = {
  captcha: "a CAPTCHA",
  login: "a sign-in",
  mfa: "a verification code",
  account: "an account sign-up",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The words for a push, from known codes only. Anything else shows the generic line: the browser
// requires a notification for every push, and no text from a push is ever shown as it came.
function words(data) {
  if (
    data &&
    data.v === 1 &&
    data.kind === "handoff" &&
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    Object.hasOwn(ATS_FORM, data.ats) &&
    Object.hasOwn(CHALLENGE, data.reason)
  ) {
    return {
      title: "Needs your hands",
      body: `${ATS_FORM[data.ats]} stopped at ${CHALLENGE[data.reason]}. Open Northstar to finish it.`,
      tag: `handoff:${data.id}`,
    };
  }
  return { title: "Northstar", body: "Something needs you. Open Northstar.", tag: "northstar" };
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const w = words(data);
  event.waitUntil(self.registration.showNotification(w.title, { body: w.body, tag: w.tag }));
});

// Tapping opens Today on this app's own origin, never a URL from the push.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.navigate("/").then((c) => (c ? c.focus() : w.focus()));
        }
      }
      return self.clients.openWindow("/");
    }),
  );
});
