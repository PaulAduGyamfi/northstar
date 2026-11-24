// B · Momentum clickable prototype (NS-107, UX-002). Plain script: file:// can't load modules.
// State lives in memory and resets on reload. Nothing is sent anywhere.
(() => {
  // ---------- State ----------
  const D = window.NS_DATA;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const state = {
    screen: "today",
    jobs: clone(D.jobs),
    decided: {}, // id -> "approved" | "skipped"
    pipeline: clone(D.pipeline),
    closed: clone(D.closed),
    handoffs: clone(D.handoffs),
    feed: clone(D.feed),
    tracks: clone(D.tracks),
    quests: clone(D.quests),
    week: clone(D.week),
    heat: clone(D.heat),
    settings: clone(D.settings),
    view: readSession("ns-view") || "stack", // UX-042: remembers the last view
    stackPos: 0, // which individual card is on top
    showBatch: false,
    batchOff: {}, // id -> true when unchecked in the batch card
    compactPos: 0,
    celebrated: {},
    appliedToday: [], // minutes-after-posting for each submission, for the clear scene
    flashFeed: null,
  };

  const SCREENS = [
    "today",
    "queue",
    "pipeline",
    "grow",
    "diagnostics",
    "settings",
    "more",
    "inbox",
  ];
  const STAGES = [
    { key: "submitted", label: "Submitted" },
    { key: "replied", label: "Replied" },
    { key: "screen", label: "Screen" },
    { key: "interview", label: "Interview" },
    { key: "offer", label: "Offer" },
  ];
  const UNDO_SECONDS = 6;
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Small helpers ----------
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // Escape text for innerHTML. The data is synthetic, but the habit matters.
  function esc(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function money(n) {
    return `$${Math.round(n / 1000)}k`;
  }

  function ago(minutes) {
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
    return `${Math.round(minutes / (60 * 24))} days ago`;
  }

  function readSession(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: the prototype still works, it just forgets.
    }
  }

  function announce(text) {
    const region = $("[data-announce]");
    region.textContent = "";
    window.setTimeout(() => {
      region.textContent = text;
    }, 30);
  }

  const jobById = (id) => state.jobs.find((job) => job.id === id);

  // ---------- Scout's rules: why a job is skipped (UX-014) ----------
  function skipReason(job) {
    const s = state.settings;
    if (job.ruleSkip === "clearance") {
      return "Needs an active security clearance. Your profile says you don't hold one.";
    }
    if (job.ruleSkip === "stale") {
      return `Posted ${ago(job.postedMin)}. Your freshness rule skips jobs older than 72 hours.`;
    }
    if (!s.locations.some((place) => job.location.includes(place))) {
      return `${job.location} isn't on your locations list (${s.locations.join(", ") || "empty"}).`;
    }
    if (job.comp[1] < s.compFloor) {
      return `Pays up to ${money(job.comp[1])}, below your ${money(s.compFloor)} comp floor.`;
    }
    return null;
  }

  // Fresh-first (UX-047, SRC-013): fit weighted by how recently it was posted.
  const rank = (job) => job.fit.overall * Math.exp(-job.postedMin / 240);

  function queueJobs() {
    return state.jobs
      .filter((job) => !state.decided[job.id] && !skipReason(job))
      .sort((a, b) => rank(b) - rank(a));
  }

  // Cards that need Paul's own judgement go in the stack; auto-rule matches go in the batch.
  const individualJobs = () => queueJobs().filter((job) => job.lock || !job.autoRule);
  const batchJobs = () => queueJobs().filter((job) => !job.lock && job.autoRule);
  const ruleSkipped = () => state.jobs.filter((job) => !state.decided[job.id] && skipReason(job));
  const userSkipped = () => state.jobs.filter((job) => state.decided[job.id] === "skipped");
  const compFits = (job) => job.comp[1] >= state.settings.compFloor;

  // ---------- Router ----------
  function route() {
    const hash = window.location.hash.replace("#", "");
    state.screen = SCREENS.includes(hash) ? hash : "today";
    render();
    const main = $("#main");
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function go(screen) {
    if (window.location.hash === `#${screen}`) {
      route();
    } else {
      window.location.hash = screen;
    }
  }

  function render() {
    for (const section of $$("[data-screen]")) {
      section.hidden = section.dataset.screen !== state.screen;
    }
    for (const link of $$("[data-nav]")) {
      const isMore =
        link.dataset.nav === "more" && ["diagnostics", "settings"].includes(state.screen);
      if (link.dataset.nav === state.screen || isMore) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
    const count = individualJobs().length + batchJobs().length;
    $('[data-count="queue"]').textContent = count > 0 ? String(count) : "";
    renderHealth();
    const renderers = {
      today: renderToday,
      queue: renderQueue,
      pipeline: renderPipeline,
      grow: renderGrow,
      diagnostics: renderDiagnostics,
      settings: renderSettings,
      more: renderMore,
      inbox: renderInbox,
    };
    renderers[state.screen]($(`[data-screen="${state.screen}"]`));
  }

  function renderHealth() {
    const button = $('[data-action="health"]');
    const paused = state.handoffs.length;
    button.dataset.state = paused > 0 ? "paused" : "ok";
    $(".health-label", button).textContent =
      paused > 0 ? `${paused} paused · needs you` : "Agents healthy";
  }

  // ---------- Today (UX-010) ----------
  function renderToday(el) {
    const look = individualJobs().length;
    const batch = batchJobs().length;
    const interviews = state.pipeline.filter((p) => p.stage === "interview").length;
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">${esc(D.today)}</p><h1 id="h-today" class="big">What needs you</h1></div>
        <p>Minimum viable day: approve 1 thing or do 15 min of growth.</p>
      </div>
      <div class="needs">
        <button class="need" data-n="queue" data-go="queue" type="button">
          <b>${look + batch}</b><span>in your queue · ${look} to look at, ${batch} ready to batch-approve</span>
        </button>
        <button class="need" data-n="hands" data-go="pipeline" type="button">
          <b>${state.handoffs.length}</b><span>needs your hands (~90 s)</span>
        </button>
        <button class="need" data-n="paused" data-action="show-paused" type="button">
          <b>${state.handoffs.length}</b><span>step paused · see what happened</span>
        </button>
        <button class="need" data-n="interview" data-go="pipeline" type="button">
          <b>${interviews}</b><span>interview this week · prep plan ready</span>
        </button>
      </div>
      <div class="grid-3">
        <div class="stack-col">
          <div class="card"><h2>This week's inputs</h2>${ringSvg()}</div>
          <div class="card"><h2>Weekly quests <span class="mono">${state.week.restDaysBanked} rest days banked</span></h2>${questList()}
            <p class="rest-note">Rest days bank automatically. A quiet day never resets anything.</p>
          </div>
        </div>
        <div class="card">
          <h2>Your agent crew <span class="mono">3 working</span></h2>
          ${feedHtml()}
        </div>
        <div class="stack-col">
          ${state.handoffs.map(handoffCard).join("")}
          <div class="card">
            <h2>Journey · 30 days</h2>
            <div class="chips">${STAGES.map(
              (stage) =>
                `<span class="status" data-s="${stage.key}">${stage.label} ${state.pipeline.filter((p) => p.stage === stage.key).length}</span>`,
            ).join("")}
              <span class="status" data-s="closed">Closed ${state.closed.length}</span>
            </div>
            <p class="rest-note">Closed applications go to the Learned-from tray and feed Diagnostics.</p>
          </div>
        </div>
      </div>`;
    if (state.flashFeed) {
      const bubble = $(`[data-feed="${state.flashFeed}"]`, el);
      if (bubble) {
        bubble.dataset.flash = "true";
        // After route() has focused <main>, move focus to the paused step's action.
        window.setTimeout(() => {
          bubble.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
          $("button", bubble)?.focus({ preventScroll: true });
        }, 0);
      }
      state.flashFeed = null;
    }
  }

  function ringSvg() {
    const w = state.week;
    const apps = Math.min(w.apps / w.appsTarget, 1);
    const grow = Math.min(w.growthMin / w.growthTargetMin, 1);
    const outer = 2 * Math.PI * 82;
    const inner = 2 * Math.PI * 62;
    const pct = Math.round(((apps + grow) / 2) * 100);
    return `
      <div class="ring-wrap" role="img" aria-label="${w.apps} of ${w.appsTarget} applications and ${Math.round(w.growthMin / 60)} of ${w.growthTargetMin / 60} growth hours this week">
        <svg viewBox="0 0 190 190" aria-hidden="true">
          <circle class="ring-track" cx="95" cy="95" r="82" stroke-width="14"></circle>
          <circle class="ring-apps" cx="95" cy="95" r="82" stroke-width="14" transform="rotate(-90 95 95)"
            stroke-dasharray="${outer}" stroke-dashoffset="${outer * (1 - apps)}"></circle>
          <circle class="ring-track" cx="95" cy="95" r="62" stroke-width="12"></circle>
          <circle class="ring-grow" cx="95" cy="95" r="62" stroke-width="12" transform="rotate(-90 95 95)"
            stroke-dasharray="${inner}" stroke-dashoffset="${inner * (1 - grow)}"></circle>
        </svg>
        <div class="ring-center"><b>${pct}%</b><span class="muted">of weekly goal</span></div>
      </div>
      <div class="ring-legend">
        <span><i class="legend-dot" style="background:var(--coral)"></i>${w.apps}/${w.appsTarget} applications</span>
        <span><i class="legend-dot" style="background:var(--iris)"></i>${(w.growthMin / 60).toFixed(1)}/${w.growthTargetMin / 60} h growth</span>
      </div>`;
  }

  function questList() {
    return state.quests
      .map((q) => {
        const done = q.value >= q.target;
        const width = Math.min(100, Math.round((q.value / q.target) * 100));
        const label = q.minutes
          ? `${(q.value / 60).toFixed(1)} of ${q.target / 60} growth hours`
          : q.id === "q1"
            ? `${q.value} of ${q.target} applications`
            : q.text;
        return `<div class="quest" data-done="${done}">
          <span class="ck" aria-hidden="true">${done ? "✓" : ""}</span>
          <span class="label">${esc(label)}${done ? '<span class="sr-only"> (done)</span>' : ""}</span>
          <span class="bar" aria-hidden="true"><i style="width:${width}%;--b:var(--${q.color})"></i></span>
        </div>`;
      })
      .join("");
  }

  function feedHtml() {
    const items = state.feed
      .map(
        (f) => `<div class="bubble" data-feed="${f.id}" data-kind="${f.kind || "info"}">
          <span class="avatar" data-agent="${esc(f.agent)}" aria-hidden="true">${esc(f.agent.slice(0, 2))}</span>
          <div class="bubble-body">
            <div><strong>${esc(f.agent)}${f.kind === "paused" ? " · paused" : ""}:</strong> ${esc(f.text)}</div>
            <div class="bubble-meta">${esc(f.ago)}</div>
            <div class="bubble-actions">${(f.actions || [])
              .map((a) =>
                a.go
                  ? `<button class="btn" type="button" data-go="${a.go}">${esc(a.label)}</button>`
                  : `<button class="btn" type="button" data-why="${a.why}">${esc(a.label)}</button>`,
              )
              .join("")}</div>
          </div>
        </div>`,
      )
      .join("");
    return `<div class="feed">${items}<p class="feed-end">That's everything. Agents keep watching.</p></div>`;
  }

  function handoffCard(h) {
    return `<div class="card handoff">
      <div><span class="status" data-s="hands">Needs your hands</span>
        <h2 style="margin:8px 0 4px">${esc(h.company)} · ${esc(h.title)}</h2>
        <p class="muted">${esc(h.reason)}</p></div>
      <button class="btn btn-primary" type="button" data-handoff="${h.id}">Finish it (${esc(h.eta)})</button>
    </div>`;
  }

  // ---------- Queue: stack and compact (UX-041, UX-042, UX-043) ----------
  function renderQueue(el) {
    const look = individualJobs();
    const batch = batchJobs();
    const total = look.length + batch.length;
    const done = state.appliedToday.length;
    const width = done + total === 0 ? 100 : Math.round((done / (done + total)) * 100);
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">Power hour · freshest first</p><h1 id="h-queue" class="big">Queue</h1></div>
        <div class="toggle" role="group" aria-label="Queue view">
          <button type="button" data-action="view" data-view="stack" aria-pressed="${state.view === "stack"}">Cards</button>
          <button type="button" data-action="view" data-view="compact" aria-pressed="${state.view === "compact"}">Compact <span class="kbd">V</span></button>
        </div>
      </div>
      <div class="queue-bar">
        <span class="mono">${look.length} to look at · ${batch.length} ready to batch-approve</span>
        <span class="progress" aria-hidden="true"><i style="width:${width}%"></i></span>
        ${batch.length > 0 ? `<button class="btn" type="button" data-action="show-batch">Batch-approve ${batch.length} <kbd>B</kbd></button>` : ""}
      </div>
      <div data-queue-body></div>
      <div class="card skipped">
        <h2>Skipped by Scout <span class="mono">${ruleSkipped().length} today</span></h2>
        <ul class="skipped-list">${ruleSkipped()
          .map(
            (job) => `<li><div><strong>${esc(job.company)}</strong> · ${esc(job.title)}<br>
              <span class="muted">${esc(skipReason(job))}</span></div>
              <button class="btn" type="button" data-why="${job.id}">Why skipped?</button></li>`,
          )
          .join("")}${userSkipped()
          .map(
            (job) => `<li><div><strong>${esc(job.company)}</strong> · ${esc(job.title)}<br>
              <span class="muted">You skipped it.</span></div>
              <button class="btn" type="button" data-unskip="${job.id}">Bring back</button></li>`,
          )
          .join("")}</ul>
      </div>`;
    const body = $("[data-queue-body]", el);
    if (state.view === "compact") {
      renderCompact(body);
    } else {
      renderStack(body);
    }
  }

  function renderStack(el) {
    const look = individualJobs();
    const batch = batchJobs();
    const batchMode = state.showBatch && batch.length > 0;
    if (look.length > 0 && !batchMode) {
      state.stackPos = Math.min(state.stackPos, look.length - 1);
      el.innerHTML = `<div class="stack">${look.length > 1 ? '<div class="stack-shadow"></div>' : ""}${jobCard(look[state.stackPos], state.stackPos + 1, look.length)}</div>`;
      attachDrag($(".jobcard", el));
    } else if (batch.length > 0) {
      el.innerHTML = `<div class="stack">${batchCard(batch)}</div>`;
    } else {
      el.innerHTML = `<div class="stack">${clearScene()}</div>`;
    }
  }

  function jobCard(job, position, of) {
    const fitComp =
      compFits(job) && state.settings.locations.some((place) => job.location.includes(place));
    return `<article class="jobcard" data-card="${job.id}" aria-label="${esc(job.title)} at ${esc(job.company)}, card ${position} of ${of}">
      <div class="chips">
        <span class="chip chip-fresh">⚡ posted ${ago(job.postedMin)}</span>
        ${job.tag ? `<span class="chip chip-lime">${esc(job.tag)}</span>` : ""}
        ${job.lock ? '<span class="chip chip-lock">🔒 Needs a look</span>' : ""}
        <span class="mono muted">${position} of ${of}</span>
      </div>
      <h2>${esc(job.title)}</h2>
      <p class="sub">${esc(job.company)} · ${esc(job.location)} · ${money(job.comp[0])}–${money(job.comp[1])}</p>
      <div class="fit">
        <div class="tile"><b>${job.fit.overall}</b><span>overall fit</span></div>
        <div class="tile"><b>${job.fit.skills}</b><span>skills</span></div>
        <div class="tile"><b>${job.fit.level}</b><span>level</span></div>
        <div class="tile"><b>${fitComp ? "✓" : "✕"}</b><span>comp · location</span></div>
      </div>
      <div class="why"><span class="lead">Why it's a match:</span> ${esc(job.why)}
        <button class="btn-quiet btn" type="button" data-why="${job.id}">Evidence <kbd>W</kbd></button></div>
      ${job.lock ? `<div class="lock-note"><span aria-hidden="true">🔒</span><span><strong>Opens for review first.</strong> ${esc(job.lock.text)}</span></div>` : ""}
      <div class="actions">
        <button class="btn" type="button" data-skip="${job.id}">✕ Skip <kbd>S</kbd></button>
        <button class="btn" type="button" data-review="${job.id}">✎ Review / edit <kbd>E</kbd></button>
        <button class="btn btn-primary" type="button" data-approve="${job.id}">${job.lock ? "Review to approve" : "✓ Approve"} <kbd>A</kbd></button>
      </div>
      <p class="hint">Swipe right to approve, left to skip, up to edit · or press A / S / E · J / K for next / previous</p>
    </article>`;
  }

  function batchCard(batch) {
    const chosen = batch.filter((job) => !state.batchOff[job.id]);
    return `<article class="card batch" data-batch aria-labelledby="batch-title">
      <h2 id="batch-title" class="big" style="font-size:28px">These ${batch.length} match your auto-rules. Approve all?</h2>
      <p class="muted">Every answer reused, high confidence, no warnings. Untick any you want to look at first.</p>
      <ul class="batch-list">${batch
        .map(
          (job) => `<li>
          <input type="checkbox" id="b-${job.id}" data-batch-toggle="${job.id}" ${state.batchOff[job.id] ? "" : "checked"}>
          <label for="b-${job.id}"><strong>${esc(job.company)}</strong> · ${esc(job.title)}<br>
            <span class="muted">fit ${job.fit.overall} · ${money(job.comp[0])}–${money(job.comp[1])}</span></label>
          <span class="chip chip-fresh">${ago(job.postedMin)}</span>
          <button class="btn btn-quiet" type="button" data-why="${job.id}">Why?</button>
        </li>`,
        )
        .join("")}</ul>
      <div class="actions">
        ${individualJobs().length > 0 ? '<button class="btn" type="button" data-action="hide-batch">Back to cards</button>' : ""}
        <button class="btn btn-primary" type="button" data-action="approve-batch" ${chosen.length === 0 ? "disabled" : ""}>✓ Approve ${chosen.length} <kbd>A</kbd></button>
      </div>
    </article>`;
  }

  function clearScene() {
    const times = state.appliedToday;
    const fastest = times.length > 0 ? Math.min(...times) : null;
    return `<div class="card clear-scene">
      <p class="mono muted">Queue clear</p>
      <h2 class="big">You're done for now.</h2>
      <p class="muted">Agents keep watching. Scout checks new postings every 10 minutes.</p>
      <div class="stats">
        <span class="tile"><strong>${times.length}</strong> applied this session</span>
        ${fastest !== null ? `<span class="tile"><strong>${fastest} min</strong> fastest after posting</span>` : ""}
        <span class="tile"><strong>${state.week.apps}/${state.week.appsTarget}</strong> this week</span>
      </div>
      <div class="actions">
        <button class="btn" type="button" data-go="pipeline">See pipeline</button>
        <button class="btn btn-iris" type="button" data-go="grow">Log growth</button>
      </div>
    </div>`;
  }

  function renderCompact(el) {
    const rows = queueJobs();
    if (rows.length === 0) {
      el.innerHTML = `<div class="stack">${clearScene()}</div>`;
      return;
    }
    state.compactPos = Math.min(state.compactPos, rows.length - 1);
    el.innerHTML = `<table class="compact" aria-label="Queue, compact view. J and K move, A approves, S skips, E reviews.">
      <thead><tr><th>Posted</th><th>Role</th><th class="hide-sm">Fit</th><th class="hide-sm">Comp</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows
        .map((job, i) => {
          // One status vocabulary (UX-020): every queued row is "Awaiting you"; the lock and the
          // auto-rule match are plain chips, not states.
          const status = `<span class="status" data-s="awaiting">Awaiting you</span>${
            job.lock
              ? ' <span class="chip chip-lock">🔒 Needs a look</span>'
              : job.autoRule
                ? ' <span class="chip">Auto-rule</span>'
                : ""
          }`;
          return `<tr data-row="${job.id}" aria-selected="${i === state.compactPos}">
            <td class="mono">${ago(job.postedMin)}</td>
            <td><strong>${esc(job.company)}</strong> · ${esc(job.title)}</td>
            <td class="hide-sm mono">${job.fit.overall}</td>
            <td class="hide-sm mono">${money(job.comp[0])}–${money(job.comp[1])}</td>
            <td>${status}</td>
            <td><div class="row-actions">
              <button class="btn" type="button" data-approve="${job.id}" aria-label="Approve ${esc(job.company)}">A</button>
              <button class="btn" type="button" data-skip="${job.id}" aria-label="Skip ${esc(job.company)}">S</button>
              <button class="btn" type="button" data-review="${job.id}" aria-label="Review ${esc(job.company)}">E</button>
              <button class="btn" type="button" data-why="${job.id}" aria-label="Why ${esc(job.company)}">W</button>
            </div></td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
  }

  // ---------- Queue actions ----------
  function approve(id) {
    const job = jobById(id);
    if (!job || state.decided[id]) return;
    // Review lock (UX-041): a locked card goes out only from inside its open review. A key,
    // a swipe or a button anywhere else opens the review instead.
    if (job.lock && dialogApproveId !== id) {
      announce(`${job.company} needs a look before it can be approved. Opening the review.`);
      openReview(id);
      return;
    }
    submit([job]);
  }

  // Submits after an undo window (UX-016): the card leaves the queue now, the application goes
  // out when the countdown ends unless Paul presses Undo.
  function submit(jobs) {
    for (const job of jobs) {
      state.decided[job.id] = "approved";
      state.pipeline.unshift({
        id: `p-${job.id}`,
        title: job.title,
        company: job.company,
        stage: "submitting",
        days: 0,
        fromJob: job.id,
      });
    }
    closeDialog();
    render();
    focusQueue();
    const names = jobs.length === 1 ? jobs[0].company : `${jobs.length} applications`;
    undoToast(
      `Submitting ${names} in`,
      () => {
        for (const job of jobs) {
          delete state.decided[job.id];
          state.pipeline = state.pipeline.filter((p) => p.fromJob !== job.id);
        }
        render();
        announce(`Undone. ${names} went back to your queue.`);
      },
      () => {
        for (const job of jobs) {
          const entry = state.pipeline.find((p) => p.fromJob === job.id);
          if (entry) entry.stage = "submitted";
          state.week.apps += 1;
          state.appliedToday.push(job.postedMin);
        }
        const q1 = state.quests.find((q) => q.id === "q1");
        if (q1) q1.value = state.week.apps;
        render();
        // Celebration ladder, first rung: a small coral burst, only when it went out within an
        // hour of posting (UX-031). Swipes and approvals themselves never celebrate.
        const fastest = Math.min(...jobs.map((job) => job.postedMin));
        if (fastest <= 60) celebrateSmall();
        const line =
          jobs.length === 1
            ? `Applied to <span class="em">${esc(jobs[0].company)}</span> ${fastest} min after posting.`
            : `Applied to <span class="em">${jobs.length} roles</span>, the freshest ${fastest} min after posting.`;
        toast(line);
      },
    );
  }

  function skip(id) {
    const job = jobById(id);
    if (!job || state.decided[id]) return;
    state.decided[id] = "skipped";
    closeDialog();
    render();
    focusQueue();
    undoToast(`Skipped ${job.company}.`, () => {
      delete state.decided[id];
      render();
    });
  }

  // After an action, focus the new top card, the selected row or the batch, so keyboard users
  // don't fall back to the top of the page.
  function focusQueue() {
    if (state.screen !== "queue") return;
    const target = $(".jobcard, tr[aria-selected='true'], #batch-title, .clear-scene h2");
    if (!target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function stackStep(delta) {
    const look = individualJobs();
    if (look.length === 0) return;
    state.stackPos = (state.stackPos + delta + look.length) % look.length;
    render();
  }

  function currentJobId() {
    if (state.view === "compact") {
      return queueJobs()[state.compactPos]?.id;
    }
    if (state.showBatch && batchJobs().length > 0) return null;
    return individualJobs()[state.stackPos]?.id;
  }

  function approveBatch() {
    const chosen = batchJobs().filter((job) => !state.batchOff[job.id]);
    if (chosen.length === 0) return;
    state.showBatch = false;
    submit(chosen);
  }

  // Drag to swipe, with the same rules as the buttons (UX-043: buttons and keys always exist).
  function attachDrag(card) {
    if (!card) return;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      card.classList.add("dragging");
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = Math.min(0, event.clientY - startY);
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 25}deg)`;
    });
    card.addEventListener("pointercancel", () => {
      dragging = false;
      card.classList.remove("dragging");
      card.style.transform = "";
    });
    card.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("dragging");
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const id = card.dataset.card;
      const job = jobById(id);
      card.style.transform = "";
      if (dx > 120) {
        if (job.lock) {
          approve(id); // opens the review instead
        } else {
          flyThen(card, "fly-right", () => approve(id));
        }
      } else if (dx < -120) {
        flyThen(card, "fly-left", () => skip(id));
      } else if (dy < -120 && event.pointerType === "mouse") {
        openReview(id);
      }
    });
  }

  function flyThen(card, className, then) {
    if (reducedMotion()) {
      then();
      return;
    }
    card.classList.add(className);
    window.setTimeout(then, 220);
  }

  // ---------- Review and why dialogs ----------
  function openReview(id) {
    const job = jobById(id);
    if (!job) return;
    openDialog(
      `
      <p class="mono muted">Review before it goes out</p>
      <h2 id="dialog-title">${esc(job.title)}</h2>
      <p class="muted">${esc(job.company)} · ${esc(job.location)} · ${money(job.comp[0])}–${money(job.comp[1])}</p>
      ${job.lock ? `<div class="lock-note"><span aria-hidden="true">🔒</span><span><strong>Why this opened:</strong> ${esc(job.lock.text)}</span></div>` : ""}
      <h3 style="margin-top:16px;font-size:15px">Resume</h3>
      <p class="muted">Variant payments-v3. Tailor changed 2 lines; every line cites a story or experience atom.</p>
      <h3 style="margin-top:16px;font-size:15px">Answers</h3>
      ${(job.answers.length > 0
        ? job.answers
        : [{ q: "No custom questions", a: "Standard form only.", isNew: false }]
      )
        .map(
          (a, i) => `<div class="answer" data-new="${a.isNew}">
          <div class="q">${a.isNew ? "New · " : ""}${esc(a.q)}</div>
          ${
            a.isNew
              ? `<label class="field"><span class="sr-only">Answer</span><textarea rows="4" data-answer="${i}">I led the response to a queue backlog that delayed 40,000 payouts. I split the backlog by merchant, added back-pressure, and we drained it in 3 hours with no double payouts. Afterwards I wrote the runbook we still use.</textarea></label><small class="muted">${esc(a.a)}</small>`
              : `<div class="muted">${esc(a.a)}</div>`
          }
        </div>`,
        )
        .join("")}
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="close-dialog">Close <kbd>Esc</kbd></button>
        <button class="btn" type="button" data-skip="${job.id}">Skip <kbd>S</kbd></button>
        <button class="btn btn-primary" type="button" data-approve="${job.id}">✓ Approve after review <kbd>A</kbd></button>
      </div>`,
      { approveId: job.id },
    );
    render();
  }

  function openWhy(id) {
    const job = jobById(id);
    if (!job) return;
    const reason = skipReason(job);
    const settingsLink =
      reason && (reason.includes("comp floor") || reason.includes("locations list"))
        ? '<button class="btn" type="button" data-action="go-settings">Change it in Settings</button>'
        : "";
    openDialog(`
      <p class="mono muted">${reason ? "Why Scout skipped it" : "Why it's a match"}</p>
      <h2 id="dialog-title">${esc(job.company)} · ${esc(job.title)}</h2>
      ${reason ? `<div class="lock-note"><span aria-hidden="true">↷</span><span><strong>Skipped:</strong> ${esc(reason)}</span></div>` : ""}
      <h3 style="margin-top:14px;font-size:15px">Evidence</h3>
      <ul class="evidence">${job.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <div class="fit">
        <div class="tile"><b>${job.fit.overall}</b><span>overall</span></div>
        <div class="tile"><b>${job.fit.skills}</b><span>skills</span></div>
        <div class="tile"><b>${job.fit.level}</b><span>level</span></div>
        <div class="tile"><b>${compFits(job) ? "✓" : "✕"}</b><span>comp floor</span></div>
      </div>
      <div class="dialog-actions">${settingsLink}
        <button class="btn btn-primary" type="button" data-action="close-dialog">Got it</button>
      </div>`);
  }

  // ---------- Pipeline ----------
  function renderPipeline(el) {
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">Journey · 30 days</p><h1 id="h-pipeline" class="big">Pipeline</h1></div>
        <button class="btn" type="button" data-action="demo-interview">Demo: an interview gets booked</button>
      </div>
      ${state.handoffs.map(handoffCard).join("")}
      <div class="journey">${STAGES.map((stage) => lane(stage)).join("")}</div>
      <div class="card tray">
        <h2>Learned-from tray <span class="mono">${state.closed.length} closed · fed to Diagnostics</span></h2>
        <ul class="tray-list">${state.closed
          .map(
            (c) => `<li><span class="status" data-s="closed">Closed</span><br>
              <strong>${esc(c.company)}</strong> · ${esc(c.title)}<br><span class="muted">${esc(c.learned)}</span></li>`,
          )
          .join("")}</ul>
      </div>`;
  }

  function lane(stage) {
    const items = state.pipeline.filter(
      (p) => p.stage === stage.key || (stage.key === "submitted" && p.stage === "submitting"),
    );
    return `<section class="lane" aria-label="${stage.label}, ${items.length}">
      <h2><span>${stage.label}</span><span class="mono muted">${items.length}</span></h2>
      ${items
        .map(
          (p) => `<div class="token">
          <span class="status" data-s="${p.stage}">${p.stage === "submitting" ? "Submitting" : stage.label}</span>
          <span class="title">${esc(p.company)}</span>
          <span class="muted">${esc(p.title)}</span>
          ${
            p.stage === "submitting"
              ? '<span class="muted">Undo window open</span>'
              : `<label><span class="sr-only">Move ${esc(p.company)} to</span>
            <select data-move="${p.id}">
              <option value="">Move to…</option>
              ${STAGES.filter((s) => s.key !== p.stage)
                .map((s) => `<option value="${s.key}">${s.label}</option>`)
                .join("")}
              <option value="closed">Closed</option>
            </select></label>`
          }
        </div>`,
        )
        .join("")}
    </section>`;
  }

  function moveApplication(id, stage) {
    const entry = state.pipeline.find((p) => p.id === id);
    if (!entry || !stage) return;
    if (stage === "closed") {
      state.pipeline = state.pipeline.filter((p) => p.id !== id);
      state.closed.unshift({
        id,
        title: entry.title,
        company: entry.company,
        learned: "Closed by you. Diagnostics will count it.",
      });
      render();
      undoToast(`Moved ${entry.company} to Closed.`, () => {
        state.closed = state.closed.filter((c) => c.id !== id);
        state.pipeline.unshift(entry);
        render();
      });
      return;
    }
    const before = entry.stage;
    entry.stage = stage;
    render();
    if (stage === "interview" && !state.celebrated[id]) {
      state.celebrated[id] = true;
      celebrateInterview(entry);
    } else {
      undoToast(
        `Moved ${entry.company} to ${STAGES.find((s) => s.key === stage)?.label ?? stage}.`,
        () => {
          entry.stage = before;
          render();
        },
      );
    }
  }

  function finishHandoff(id) {
    const h = state.handoffs.find((item) => item.id === id);
    if (!h) return;
    openDialog(`
      <p class="mono muted">Needs your hands</p>
      <h2 id="dialog-title">${esc(h.company)} · ${esc(h.title)}</h2>
      <p>${esc(h.reason)}</p>
      <p class="muted" style="margin-top:10px">In the real app this opens the pre-filled form in your browser through the extension. Upload the work sample and press submit there; Northstar notices and tracks it.</p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="close-dialog">Later</button>
        <button class="btn btn-primary" type="button" data-handoff-done="${h.id}">I submitted it</button>
      </div>`);
  }

  function handoffDone(id) {
    const h = state.handoffs.find((item) => item.id === id);
    if (!h) return;
    state.handoffs = state.handoffs.filter((item) => item.id !== id);
    state.feed = state.feed.filter((f) => f.kind !== "paused");
    state.pipeline.unshift({
      id: `p-${id}`,
      title: h.title,
      company: h.company,
      stage: "submitted",
      days: 0,
    });
    closeDialog();
    render();
    toast(`Thanks. <span class="em">${esc(h.company)}</span> is in your pipeline.`);
  }

  // ---------- Grow ----------
  function renderGrow(el) {
    const w = state.week;
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">${(w.growthMin / 60).toFixed(1)} of ${w.growthTargetMin / 60} hours this week</p><h1 id="h-grow" class="big">Grow</h1></div>
        <p>${w.restDaysBanked} rest days banked. Progress fades slowly; nothing resets.</p>
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>Tracks</h2>
          ${state.tracks
            .map((t) => {
              const pct = Math.min(100, Math.round((t.doneMin / t.targetMin) * 100));
              return `<div class="track">
                <div class="track-head"><strong>${esc(t.name)}</strong><span class="mono">${(t.doneMin / 60).toFixed(1)} / ${t.targetMin / 60} h</span></div>
                <span class="bar" role="progressbar" aria-label="${esc(t.name)}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%;--b:var(--iris)"></i></span>
                <div class="track-head"><span class="muted">Next: ${esc(t.next)}</span>
                  <button class="btn btn-quiet" type="button" data-log-track="${t.id}">Log progress</button></div>
              </div>`;
            })
            .join("")}
        </div>
        <div class="stack-col">
          <form class="card form" data-grow-form>
            <h2>Log progress</h2>
            <label class="field">Track
              <select name="track" data-grow-track>${state.tracks
                .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
                .join("")}</select></label>
            <label class="field">Minutes
              <input name="minutes" type="number" min="5" max="480" step="5" value="30" required></label>
            <label class="field">Note <small>optional, for your weekly recap</small>
              <input name="note" type="text" maxlength="120" placeholder="Finished practice exam 2"></label>
            <button class="btn btn-iris" type="submit">Log it</button>
          </form>
          <div class="card">
            <h2>Last 12 weeks <span class="mono">applications + growth</span></h2>
            <div class="heat" role="img" aria-label="Activity heatmap for the last 12 weeks, rising toward this week">${state.heat
              .map(
                (week) =>
                  `<div class="heat-col">${week.map((l) => `<i data-l="${l}"></i>`).join("")}</div>`,
              )
              .join("")}</div>
          </div>
        </div>
      </div>`;
  }

  function logGrowth(trackId, minutes, note) {
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track || !(minutes > 0)) return;
    track.doneMin += minutes;
    state.week.growthMin += minutes;
    const q2 = state.quests.find((q) => q.id === "q2");
    if (q2) q2.value = state.week.growthMin;
    const lastWeek = state.heat[state.heat.length - 1];
    lastWeek[1] = Math.min(3, lastWeek[1] + 1);
    render();
    toast(
      `Logged <span class="em">${minutes} min</span> to ${esc(track.name)}${note ? `: ${esc(note)}` : ""}.`,
    );
  }

  // ---------- Diagnostics ----------
  function renderDiagnostics(el) {
    const d = D.diagnosis;
    const max = d.funnel[0].count;
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">Last 30 days</p><h1 id="h-diagnostics" class="big">Diagnostics</h1></div>
        <p>Closed applications are data, not failures. They tell us where to change course.</p>
      </div>
      <div class="grid-2">
        <div class="card diag-hero">
          <h2>Leakiest stage: ${esc(d.leak.stage)}</h2>
          <p><span class="big" style="font-size:40px">${esc(d.leak.rate)}</span> <span class="muted">reply rate · typical ${esc(d.leak.benchmark)}</span></p>
          <h3 style="margin-top:14px;font-size:15px">Hypothesis</h3>
          <p>${esc(d.leak.hypothesis)}</p>
          <ul class="evidence">${d.leak.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
          <span class="chip">${esc(d.leak.status)}</span>
        </div>
        <div class="card">
          <h2>Funnel</h2>
          <div class="funnel">${d.funnel
            .map((row, i) => {
              const prev = d.funnel[i - 1];
              const conv = prev ? `${Math.round((row.count / prev.count) * 100) || 0}%` : "";
              const leak = row.stage === "Replied";
              return `<div class="funnel-row" data-leak="${leak}">
                <span class="label">${row.stage}${leak ? " · leak" : ""}</span>
                <span class="bar" aria-hidden="true"><i style="width:${Math.max(2, (row.count / max) * 100)}%;--b:var(--${leak ? "coral" : "iris"})"></i></span>
                <span class="mono">${row.count} ${conv ? `<span class="muted">${conv}</span>` : ""}</span>
              </div>`;
            })
            .join("")}</div>
          <p class="rest-note">${state.closed.length} closed applications feed these numbers (Pipeline › Learned-from tray).</p>
        </div>
      </div>`;
  }

  // ---------- Settings (UX-017) ----------
  function renderSettings(el) {
    const s = state.settings;
    el.innerHTML = `
      <div class="screen-head">
        <div><p class="mono">Changes apply right away, with undo</p><h1 id="h-settings" class="big">Settings</h1></div>
      </div>
      <div class="grid-2">
        <div class="stack-col">
          <div class="card form">
            <h2>Comp floor</h2>
            <label class="field" for="comp-floor">Minimum yearly base pay (USD)
              <input id="comp-floor" type="number" min="50000" max="400000" step="5000" value="${s.compFloor}" data-comp-floor>
              <small>Scout skips jobs whose top of range is below this.</small></label>
            <p class="preview" data-comp-preview aria-live="polite"></p>
            <button class="btn btn-primary" type="button" data-action="apply-comp">Save comp floor</button>
          </div>
          <div class="card">
            <h2>Target roles</h2>
            <div class="chips">${s.roles.map((r, i) => removable(r, "role", i)).join("")}</div>
            <form class="inline-form" data-add="role"><label class="field" style="flex:1"><span class="sr-only">Add a role</span><input name="value" placeholder="Add a role"></label><button class="btn" type="submit">Add</button></form>
          </div>
          <div class="card">
            <h2>Locations</h2>
            <div class="chips">${s.locations.map((r, i) => removable(r, "location", i)).join("")}</div>
            <form class="inline-form" data-add="location"><label class="field" style="flex:1"><span class="sr-only">Add a location</span><input name="value" placeholder="Add a city or Remote US"></label><button class="btn" type="submit">Add</button></form>
          </div>
        </div>
        <div class="stack-col">
          <div class="card">
            <h2>Autonomy</h2>
            <div class="dial" role="radiogroup" aria-label="Autonomy">
              ${dialOption("suggest", "Suggest only", "Agents prepare packages. Nothing goes out without you.")}
              ${dialOption("approve", "Approve each (default)", "One tap or key per application, batch for auto-rule matches.")}
              ${dialOption("auto", "Auto-apply when rules match", "Rule matches go out on their own within the daily cap. Review-locked cards still wait for you.")}
            </div>
            <label class="field" style="margin-top:14px;display:flex;gap:10px;align-items:center">
              <input type="checkbox" data-pause ${s.autoApplyPaused ? "checked" : ""}> Pause all auto-apply now</label>
          </div>
          <div class="card form">
            <h2>Daily caps</h2>
            <label class="field">Applications per day<input type="number" min="0" max="50" value="${s.caps.appsPerDay}" data-cap="appsPerDay"></label>
            <label class="field">Emails per day<input type="number" min="0" max="50" value="${s.caps.emailsPerDay}" data-cap="emailsPerDay"></label>
            <label class="field">LLM spend per day (USD)<input type="number" min="0" max="100" value="${s.caps.llmDollarsPerDay}" data-cap="llmDollarsPerDay"></label>
            <p class="preview">Contact email on forms: ${esc(s.contactEmail)}</p>
          </div>
        </div>
      </div>`;
    updateCompPreview();
  }

  function removable(text, kind, index) {
    return `<span class="chip removable">${esc(text)}<button type="button" data-remove="${kind}" data-index="${index}" aria-label="Remove ${esc(text)}">×</button></span>`;
  }

  function dialOption(value, label, help) {
    const checked = state.settings.autonomy === value ? "checked" : "";
    return `<label><input type="radio" name="autonomy" value="${value}" ${checked} data-autonomy>
      <span><strong>${label}</strong><br><span class="muted">${help}</span></span></label>`;
  }

  // Shows which jobs a new comp floor would move, before saving.
  function compMoves(floor) {
    const into = [];
    const out = [];
    for (const job of state.jobs) {
      if (state.decided[job.id] || job.ruleSkip) continue;
      const nowIn = job.comp[1] >= state.settings.compFloor;
      const thenIn = job.comp[1] >= floor;
      if (!nowIn && thenIn) into.push(job.company);
      if (nowIn && !thenIn) out.push(job.company);
    }
    return { into, out };
  }

  function updateCompPreview() {
    const input = $("[data-comp-floor]");
    const preview = $("[data-comp-preview]");
    if (!input || !preview) return;
    const floor = Number(input.value);
    const { into, out } = compMoves(floor);
    const parts = [];
    if (into.length > 0)
      parts.push(
        `${into.length} job${into.length === 1 ? " moves" : "s move"} into your queue (${into.join(", ")})`,
      );
    if (out.length > 0) parts.push(`${out.length} move out (${out.join(", ")})`);
    preview.textContent =
      parts.length > 0
        ? `At ${money(floor)}: ${parts.join("; ")}.`
        : `At ${money(floor)}: no change to your queue.`;
  }

  function applyCompFloor() {
    const input = $("[data-comp-floor]");
    const floor = Number(input.value);
    if (!(floor >= 50000)) {
      toast("Enter a comp floor of at least $50k.");
      return;
    }
    const before = state.settings.compFloor;
    if (floor === before) return;
    const { into, out } = compMoves(floor);
    state.settings.compFloor = floor;
    const moved = [
      into.length > 0 ? `${into.length} moved in: ${into.join(", ")}` : "",
      out.length > 0 ? `${out.length} moved out: ${out.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    const feedItem = {
      id: `f-comp-${Date.now()}`,
      agent: "Scout",
      text: `Re-ranked your queue for a ${money(floor)} comp floor.${moved ? ` ${moved}.` : " No jobs moved."}`,
      ago: "just now",
      actions: [{ label: "See queue", go: "queue" }],
    };
    state.feed.unshift(feedItem);
    render();
    undoToast(`Comp floor is now ${money(floor)}.`, () => {
      state.settings.compFloor = before;
      state.feed = state.feed.filter((f) => f.id !== feedItem.id);
      render();
    });
  }

  // ---------- More and Inbox ----------
  function renderMore(el) {
    el.innerHTML = `
      <div class="screen-head"><h1 id="h-more" class="big">More</h1></div>
      <div class="more-grid">
        <a class="card" href="#diagnostics"><h2>Diagnostics</h2><p class="muted">Where your funnel leaks and what we're testing.</p></a>
        <a class="card" href="#settings"><h2>Settings</h2><p class="muted">Roles, locations, comp floor, autonomy, caps.</p></a>
        <div class="card"><h2>Activity log</h2><p class="muted">Not in this prototype.</p></div>
        <div class="card"><h2>Accounts</h2><p class="muted">Not in this prototype.</p></div>
      </div>`;
  }

  function renderInbox(el) {
    el.innerHTML = `<div class="screen-head"><h1 id="h-inbox" class="big">Inbox</h1></div>
      <div class="card empty"><p>Not in this prototype. The Inbox arrives with its own ticket.</p></div>`;
  }

  // ---------- Dialog, toasts, celebrations ----------
  let dialogReturnFocus = null;
  let dialogApproveId = null;

  function openDialog(html, options = {}) {
    dialogReturnFocus = document.activeElement;
    dialogApproveId = options.approveId || null;
    const dialog = $("[data-dialog]");
    dialog.innerHTML = html;
    dialog.hidden = false;
    setBackgroundInert();
    $("[data-scrim]").hidden = false;
    // Focus the heading, not a field: A and S work at once in the review, the screen reader
    // reads the title first, and Tab still reaches the answer text to edit it.
    const title = $("#dialog-title", dialog);
    if (title) {
      title.tabIndex = -1;
      title.focus();
    } else {
      $("button", dialog)?.focus();
    }
  }

  function setBackgroundInert() {
    const open =
      !$("[data-dialog]").hidden || !$("[data-palette]").hidden || !$("[data-celebration]").hidden;
    for (const el of [$(".topbar"), $("#main")]) el.inert = open;
  }

  function closeDialog() {
    const dialog = $("[data-dialog]");
    if (dialog.hidden) return;
    dialog.hidden = true;
    dialog.innerHTML = "";
    dialogApproveId = null;
    $("[data-scrim]").hidden = $("[data-palette]").hidden;
    setBackgroundInert();
    if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
    else if (state.screen === "queue") focusQueue();
    else $("#main").focus();
  }

  function toast(html, extra = "") {
    const host = $("[data-toasts]");
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span class="grow">${html}</span>${extra}`;
    host.appendChild(el);
    window.setTimeout(() => el.remove(), 4200);
    return el;
  }

  // UX-016: reversible actions get an undo toast with a countdown instead of a confirm dialog.
  function undoToast(text, undo, onCommit) {
    const host = $("[data-toasts]");
    const el = document.createElement("div");
    el.className = "toast";
    let left = UNDO_SECONDS;
    const withCount = Boolean(onCommit);
    // The seconds tick every second; hide them from screen readers, which hear one announcement.
    const label = () =>
      withCount ? `${esc(text)} <span class="mono" aria-hidden="true">${left}s</span>` : esc(text);
    el.innerHTML = `<span class="grow" data-t>${label()}</span><button type="button">Undo</button>`;
    host.appendChild(el);
    announce(`${text} Press U to undo within ${UNDO_SECONDS} seconds.`);
    let done = false;
    const timer = window.setInterval(() => {
      left -= 1;
      $("[data-t]", el).innerHTML = label();
      if (left <= 0) finish(false);
    }, 1000);
    function finish(undone) {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      el.remove();
      if (undone) undo();
      else if (onCommit) onCommit();
    }
    $("button", el).addEventListener("click", () => finish(true));
    undoStack.push(() => finish(true));
  }

  // Undo the newest pending action from the keyboard (U), so Undo isn't mouse-only.
  const undoStack = [];
  function undoLatest() {
    const latest = undoStack.pop();
    if (latest) latest();
  }

  // First rung of the ladder: a small coral burst near the queue counter.
  function celebrateSmall() {
    if (reducedMotion()) return;
    const anchor = $('[data-nav="queue"]').getBoundingClientRect();
    for (let i = 0; i < 10; i += 1) {
      const dot = document.createElement("span");
      dot.className = "burst";
      const angle = (i / 10) * Math.PI * 2;
      dot.style.left = `${anchor.left + anchor.width / 2}px`;
      dot.style.top = `${anchor.bottom + 10}px`;
      dot.style.setProperty("--dx", `${Math.cos(angle) * 46}px`);
      dot.style.setProperty("--dy", `${Math.sin(angle) * 46}px`);
      document.body.appendChild(dot);
      window.setTimeout(() => dot.remove(), 800);
    }
  }

  // Interview booked: the full-screen, once-only rung (UX-044).
  function celebrateInterview(entry) {
    const layer = $("[data-celebration]");
    layer.innerHTML = `<div class="inner" role="dialog" aria-modal="true" aria-labelledby="cele-title">
      <p class="mono muted">Interview booked</p>
      <h2 id="cele-title" class="big">${esc(entry.company)} wants to talk.</h2>
      <p class="muted">${esc(entry.title)}</p>
      <div class="card" style="margin:20px 0;text-align:left">
        <h2>Prep plan unlocked</h2>
        <p class="muted">Coach built a 3-session plan from the job, your stories S-07 and S-11, and their engineering blog.</p>
      </div>
      <button class="btn btn-primary" type="button" data-action="close-celebration">Continue</button>
    </div>`;
    layer.hidden = false;
    setBackgroundInert();
    $("button", layer).focus();
    if (reducedMotion()) return;
    const colors = ["coral", "lime", "iris", "sky"];
    for (let i = 0; i < 40; i += 1) {
      const bit = document.createElement("span");
      bit.className = "confetti";
      bit.style.left = `${Math.random() * 100}vw`;
      bit.style.top = "-20px";
      bit.style.background = `var(--${colors[i % colors.length]})`;
      bit.style.animationDelay = `${Math.random() * 400}ms`;
      layer.appendChild(bit);
    }
  }

  function closeCelebration() {
    const layer = $("[data-celebration]");
    layer.hidden = true;
    layer.innerHTML = "";
    setBackgroundInert();
    $("#main").focus();
  }

  // ---------- Command palette (UX-012) ----------
  let paletteItems = [];
  let paletteReturnFocus = null;
  let paletteIndex = 0;

  function paletteCommands() {
    const commands = [
      { label: "Go to Today", hint: "1", run: () => go("today") },
      { label: "Go to Queue", hint: "2", run: () => go("queue") },
      { label: "Go to Pipeline", hint: "3", run: () => go("pipeline") },
      { label: "Go to Grow", hint: "4", run: () => go("grow") },
      { label: "Go to Diagnostics", hint: "5", run: () => go("diagnostics") },
      { label: "Go to Settings", hint: "6", run: () => go("settings") },
      {
        label: "Change comp floor",
        hint: "Settings",
        run: () => focusAfter("settings", "[data-comp-floor]"),
      },
      {
        label: "Log growth progress",
        hint: "Grow",
        run: () => focusAfter("grow", "[data-grow-track]"),
      },
      { label: "Batch-approve auto-rule matches", hint: "Queue", run: showBatch },
      {
        label: state.settings.autoApplyPaused ? "Resume auto-apply" : "Pause auto-apply",
        hint: "Settings",
        run: togglePause,
      },
      {
        label:
          document.documentElement.dataset.theme === "night"
            ? "Switch to light mode"
            : "Switch to night mode",
        hint: "Theme",
        run: toggleTheme,
      },
      { label: "What failed or paused?", hint: "Today", run: showPaused },
    ];
    for (const job of ruleSkipped()) {
      commands.push({
        label: `Why was ${job.company} skipped?`,
        hint: "Why",
        run: () => openWhy(job.id),
      });
    }
    return commands;
  }

  function openPalette() {
    const palette = $("[data-palette]");
    paletteReturnFocus = document.activeElement;
    palette.hidden = false;
    setBackgroundInert();
    $("[data-scrim]").hidden = false;
    const input = $("[data-palette-input]");
    input.value = "";
    filterPalette("");
    input.focus();
  }

  function closePalette() {
    $("[data-palette]").hidden = true;
    $("[data-scrim]").hidden = $("[data-dialog]").hidden;
    setBackgroundInert();
    if (paletteReturnFocus?.isConnected) paletteReturnFocus.focus();
  }

  function filterPalette(text) {
    const needle = text.trim().toLowerCase();
    paletteItems = paletteCommands().filter((c) => c.label.toLowerCase().includes(needle));
    paletteIndex = 0;
    drawPalette();
  }

  function drawPalette() {
    $("[data-palette-list]").innerHTML =
      paletteItems
        .map(
          (c, i) =>
            `<li role="option" id="pal-${i}" data-pal="${i}" aria-selected="${i === paletteIndex}"><span>${esc(c.label)}</span><span class="mono muted">${esc(c.hint)}</span></li>`,
        )
        .join("") || '<li aria-disabled="true">No match</li>';
    const input = $("[data-palette-input]");
    if (paletteItems.length > 0) input.setAttribute("aria-activedescendant", `pal-${paletteIndex}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function runPalette(index) {
    const command = paletteItems[index];
    if (!command) return;
    closePalette();
    command.run();
  }

  function focusAfter(screen, selector) {
    go(screen);
    window.setTimeout(() => $(selector)?.focus(), 50);
  }

  // ---------- Global actions ----------
  function showBatch() {
    state.showBatch = true;
    if (state.view !== "stack") setView("stack");
    go("queue");
  }

  function showPaused() {
    const paused = state.feed.find((f) => f.kind === "paused");
    if (!paused) {
      openDialog(`<h2 id="dialog-title">Nothing is paused</h2><p class="muted">Every agent is running and nothing failed.</p>
        <div class="dialog-actions"><button class="btn btn-primary" type="button" data-action="close-dialog">Good</button></div>`);
      return;
    }
    state.flashFeed = paused.id;
    go("today");
  }

  function togglePause() {
    state.settings.autoApplyPaused = !state.settings.autoApplyPaused;
    render();
    undoToast(
      state.settings.autoApplyPaused
        ? "Auto-apply is paused. Nothing goes out on its own."
        : "Auto-apply is back on.",
      () => {
        state.settings.autoApplyPaused = !state.settings.autoApplyPaused;
        render();
      },
    );
  }

  function setView(view) {
    state.view = view;
    writeSession("ns-view", view);
    render();
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = $('[data-action="theme"]');
    button.setAttribute(
      "aria-label",
      theme === "night" ? "Switch to light mode" : "Switch to night mode",
    );
    $(".theme-icon", button).textContent = theme === "night" ? "☀" : "☾";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "night" ? "light" : "night";
    writeSession("ns-theme", next);
    applyTheme(next);
  }

  function showHealth() {
    const paused = state.handoffs.length;
    openDialog(`
      <p class="mono muted">System health</p>
      <h2 id="dialog-title">${paused > 0 ? "One step needs you" : "Everything is running"}</h2>
      <ul class="evidence">
        <li>Scout, Tailor, Answerer, Inbox, Coach: running.</li>
        <li>Apply: ${paused > 0 ? `${paused} application paused for your hands (${esc(state.handoffs.map((h) => h.company).join(", "))}).` : "running."}</li>
        <li>Nothing failed silently. Every pause shows up in your crew feed.</li>
      </ul>
      <div class="dialog-actions">
        ${paused > 0 ? '<button class="btn" type="button" data-action="show-paused">Show me</button>' : ""}
        <button class="btn btn-primary" type="button" data-action="close-dialog">Close</button>
      </div>`);
  }

  function showHelp() {
    openDialog(`
      <h2 id="dialog-title">Keyboard shortcuts</h2>
      <div class="shortcuts">
        <span class="kbd">Ctrl K</span><span>Command palette</span>
        <span class="kbd">1–6</span><span>Today, Queue, Pipeline, Grow, Diagnostics, Settings</span>
        <span class="kbd">A</span><span>Approve the current card (locked cards open for review)</span>
        <span class="kbd">S</span><span>Skip</span>
        <span class="kbd">E</span><span>Review or edit the package</span>
        <span class="kbd">W</span><span>Why: the evidence behind the fit</span>
        <span class="kbd">J / K</span><span>Next / previous card or row</span>
        <span class="kbd">V</span><span>Switch Cards / Compact</span>
        <span class="kbd">B</span><span>Batch-approve auto-rule matches</span>
        <span class="kbd">U</span><span>Undo the latest action while its toast shows</span>
        <span class="kbd">Esc</span><span>Close a dialog or the palette</span>
        <span class="kbd">?</span><span>This list</span>
      </div>
      <div class="dialog-actions"><button class="btn btn-primary" type="button" data-action="close-dialog">Close</button></div>`);
  }

  // ---------- Events ----------
  document.addEventListener("click", (event) => {
    const t = event.target.closest(
      "[data-action],[data-go],[data-approve],[data-skip],[data-review],[data-why],[data-handoff],[data-handoff-done],[data-unskip],[data-remove],[data-pal],[data-log-track],[data-row]",
    );
    if (!t) return;
    const d = t.dataset;
    if (d.pal !== undefined) return runPalette(Number(d.pal));
    if (d.go) {
      closeDialog();
      return go(d.go);
    }
    if (d.approve) return approve(d.approve);
    if (d.skip) return skip(d.skip);
    if (d.review) return openReview(d.review);
    if (d.why) return openWhy(d.why);
    if (d.handoff) return finishHandoff(d.handoff);
    if (d.handoffDone) return handoffDone(d.handoffDone);
    if (d.unskip) {
      delete state.decided[d.unskip];
      return render();
    }
    if (d.remove) return removeSetting(d.remove, Number(d.index));
    if (d.logTrack) {
      $("[data-grow-track]").value = d.logTrack;
      $('[data-grow-form] input[name="minutes"]').focus();
      return;
    }
    if (d.row && !event.target.closest("button")) {
      state.compactPos = queueJobs().findIndex((job) => job.id === d.row);
      return render();
    }
    const actions = {
      palette: openPalette,
      theme: toggleTheme,
      help: showHelp,
      health: showHealth,
      view: () => setView(d.view),
      "show-batch": showBatch,
      "hide-batch": () => {
        state.showBatch = false;
        render();
      },
      "approve-batch": approveBatch,
      "close-dialog": closeDialog,
      "close-celebration": closeCelebration,
      "show-paused": () => {
        closeDialog();
        showPaused();
      },
      "go-settings": () => {
        closeDialog();
        focusAfter("settings", "[data-comp-floor]");
      },
      "apply-comp": applyCompFloor,
      "demo-interview": () => {
        const entry = state.pipeline.find((p) => p.stage === "screen");
        if (entry) moveApplication(entry.id, "interview");
      },
    };
    actions[d.action]?.();
  });

  document.addEventListener("change", (event) => {
    const t = event.target;
    if (t.dataset.move !== undefined) moveApplication(t.dataset.move, t.value);
    if (t.dataset.batchToggle) {
      state.batchOff[t.dataset.batchToggle] = !t.checked;
      render();
      $(`#b-${t.dataset.batchToggle}`)?.focus();
    }
    if (t.dataset.autonomy !== undefined) {
      const before = state.settings.autonomy;
      state.settings.autonomy = t.value;
      undoToast(`Autonomy: ${t.parentElement.querySelector("strong").textContent}.`, () => {
        state.settings.autonomy = before;
        render();
      });
    }
    if (t.dataset.pause !== undefined) togglePause();
    if (t.dataset.cap) {
      const key = t.dataset.cap;
      const before = state.settings.caps[key];
      state.settings.caps[key] = Number(t.value);
      undoToast(
        `Cap saved: ${t.closest("label").firstChild.textContent.trim()} ${t.value}.`,
        () => {
          state.settings.caps[key] = before;
          render();
        },
      );
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.dataset.compFloor !== undefined) updateCompPreview();
    if (event.target.matches("[data-palette-input]")) {
      filterPalette(event.target.value);
    }
  });

  document.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.growForm !== undefined) {
      const data = new FormData(form);
      logGrowth(
        String(data.get("track")),
        Number(data.get("minutes")),
        String(data.get("note") || "").trim(),
      );
      return;
    }
    if (form.dataset.add) {
      const value = String(new FormData(form).get("value") || "").trim();
      if (!value) return;
      const list = form.dataset.add === "role" ? state.settings.roles : state.settings.locations;
      list.push(value);
      render();
      undoToast(`Added ${value}.`, () => {
        list.splice(list.lastIndexOf(value), 1);
        render();
      });
    }
  });

  function removeSetting(kind, index) {
    const list = kind === "role" ? state.settings.roles : state.settings.locations;
    const [removed] = list.splice(index, 1);
    render();
    undoToast(`Removed ${removed}.`, () => {
      list.splice(index, 0, removed);
      render();
    });
  }

  // Keys ignore typing in fields, except Esc and the palette shortcut.
  document.addEventListener("keydown", (event) => {
    const key = event.key;
    const inField = event.target.matches("input, textarea, select");
    const paletteOpen = !$("[data-palette]").hidden;
    const dialogOpen = !$("[data-dialog]").hidden;
    const celebrating = !$("[data-celebration]").hidden;

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k") {
      event.preventDefault();
      if (paletteOpen) {
        closePalette();
      } else {
        closeDialog();
        openPalette();
      }
      return;
    }
    if (key === "Escape") {
      if (celebrating) return closeCelebration();
      if (paletteOpen) return closePalette();
      if (dialogOpen) return closeDialog();
      return;
    }
    if (paletteOpen) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        const step = key === "ArrowDown" ? 1 : -1;
        paletteIndex =
          (paletteIndex + step + paletteItems.length) % Math.max(paletteItems.length, 1);
        drawPalette();
      } else if (key === "Enter") {
        event.preventDefault();
        runPalette(paletteIndex);
      }
      return;
    }
    if (inField || event.ctrlKey || event.metaKey || event.altKey || celebrating) return;

    const lower = key.toLowerCase();
    if (dialogOpen) {
      // Inside the review dialog: A approves after review, S skips.
      if (dialogApproveId && lower === "a") return approve(dialogApproveId);
      if (dialogApproveId && lower === "s") return skip(dialogApproveId);
      return;
    }
    if (key === "?") return showHelp();
    if (lower === "u") return undoLatest();
    const jump = {
      1: "today",
      2: "queue",
      3: "pipeline",
      4: "grow",
      5: "diagnostics",
      6: "settings",
    }[key];
    if (jump) return go(jump);

    if (state.screen !== "queue") return;
    const onBatch =
      state.view === "stack" &&
      (state.showBatch || individualJobs().length === 0) &&
      batchJobs().length > 0;
    if (lower === "v") return setView(state.view === "stack" ? "compact" : "stack");
    if (lower === "b") return showBatch();
    if (onBatch && lower === "a") return approveBatch();
    if (lower === "j" || lower === "k") {
      const step = lower === "j" ? 1 : -1;
      if (state.view === "compact") {
        const n = queueJobs().length;
        if (n > 0) state.compactPos = (state.compactPos + step + n) % n;
        return render();
      }
      return stackStep(step);
    }
    const id = currentJobId();
    if (!id) return;
    if (lower === "a") return approve(id);
    if (lower === "s") return skip(id);
    if (lower === "e") return openReview(id);
    if (lower === "w") return openWhy(id);
  });

  $("[data-scrim]").addEventListener("click", () => {
    closePalette();
    closeDialog();
  });

  // ---------- Start ----------
  const savedTheme = readSession("ns-theme");
  const prefersNight = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const themeParam = new URLSearchParams(window.location.search).get("theme");
  applyTheme(
    themeParam === "night" || themeParam === "light"
      ? themeParam
      : savedTheme || (prefersNight ? "night" : "light"),
  );
  window.addEventListener("hashchange", route);
  route();
})();
