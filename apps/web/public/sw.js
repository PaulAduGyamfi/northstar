// Northstar's service worker (NS-193 slice 2, ADR-0032 item 4). It shows a push's fixed words and
// opens Today when Paul taps it. Nothing else: no caching, no fetch handling, no action on Paul's
// behalf. A push carries codes and numbers only ({ v, kind, id, ats, reason } for a handoff,
// { v, kind, id, age, fit } for a fresh job, NS-199); the words below are a copy of pushWords in
// packages/domain (push-payload.ts), and a test there checks they agree.

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
// A fresh-job push's bounds (MAX_FRESH_AGE_MINUTES and the 0-100 fit score in push-payload.ts).
const MAX_FRESH_AGE_MINUTES = 24 * 60;

// A whole number from min to max, never a string or a fraction.
const wholeIn = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// "12 min ago", as ageText in push-payload.ts.
function ageText(minutes) {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / (24 * 60))} days ago`;
}

// The words for a push, from known codes only. Anything else shows the generic line: the browser
// requires a notification for every push, and no text from a push is ever shown as it came.
function words(data) {
  if (
    data &&
    data.v === 1 &&
    data.kind === "handoff" &&
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    typeof data.ats === "string" &&
    Object.hasOwn(ATS_FORM, data.ats) &&
    typeof data.reason === "string" &&
    Object.hasOwn(CHALLENGE, data.reason)
  ) {
    return {
      title: "Needs your hands",
      body: `${ATS_FORM[data.ats]} stopped at ${CHALLENGE[data.reason]}. Open Northstar to finish it.`,
      tag: `handoff:${data.id}`,
    };
  }
  if (
    data &&
    data.v === 1 &&
    data.kind === "fresh_job" &&
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    wholeIn(data.age, 0, MAX_FRESH_AGE_MINUTES) &&
    wholeIn(data.fit, 0, 100)
  ) {
    return {
      title: "A fresh job fits you",
      body: `Posted ${ageText(data.age)} · Fit ${data.fit}. Open Northstar to see it.`,
      tag: `fresh_job:${data.id}`,
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
          // navigate() refuses a tab this worker doesn't control yet: then just focus it.
          return w
            .navigate("/")
            .then((c) => (c ? c.focus() : w.focus()))
            .catch(() => w.focus());
        }
      }
      return self.clients.openWindow("/");
    }),
  );
});
