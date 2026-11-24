# UI/UX Research Brief (2026-11-24)

Produced by a research agent for UX-000. Main sources: Linear (2026 refresh, agent interaction guidelines), Smashing Magazine (agentic UX patterns and streak psychology, Feb 2026), Mobbin's study of 859 streak designs, Claude Code desktop redesign, Duolingo, W3C WCAG 2.2, competitor reviews (Jobright, Huntr, Teal, Simplify, LazyApply, Otta/WTTJ). Most competitor material is vendor-written, so it was treated as a list of features, not as proof that they work.

**Freshness evidence:** St. Louis Fed found 41% of applications arrive within 48 h. Wellfound reports a modest day-1 advantage (8.56% vs 7.65%). The popular "90% of interviews go to the first 24 h" claim has no traceable source. → Show freshness as a ranking signal and a positive ("you're early"), never as panic.

## Design principles
1. **The home screen answers "what needs me right now, and how long will it take?"** Example: "6 approvals · ~3 min".
2. **Agents act, the human decides.** The user owns every application and the agent acts for them (Linear's assignee/delegate model). Every card shows who did what.
3. **Ask for approval only where it matters.** Ask for anything irreversible or visible to others (submit, send). Don't ask for scoring, tailoring or drafting. Avoid approval fatigue.
4. **Calm by default, vivid at key moments.** Chrome recedes; color and motion are saved for real events.
5. **Track inputs, not rejections.** Celebrate what the user controls. Report outcomes neutrally, as diagnostic data.
6. **Recover rather than punish.** No hard resets. Use weekly targets, banked rest days and slow decay instead.
7. **Explain on demand.** A collapsed "Why" on every decision. Story and Log density modes.
8. **Keyboard-first and thumb-friendly.** ⌘K, single-key approve/skip, swipe on mobile. Every drag or swipe has a non-drag alternative (WCAG 2.2).

## Patterns to steal
| Source | Pattern | Our use |
|---|---|---|
| Linear agents | Typed agent activities + 4 states (working / awaiting input / error / done) | Each application is a session with a timeline. The same state chip is used app-wide |
| Linear 2026 refresh | Warm-gray neutrals, dimmed sidebar, fewer borders | Baseline chrome |
| Smashing agentic UX | Intent preview (Proceed / Edit / Do it myself), autonomy dial, undo windows | Approval cards, a per-action autonomy dial, and a ~2 min "undo send" before submit |
| Superhuman | Keyboard triage plus an earned reward image at inbox zero | "Queue clear" scene with a quiet summary |
| Claude Code desktop | Parallel sessions in a list, filter by status, auto-archive, density toggle | Activity feed grouped by session |
| Cursor (lesson from user backlash) | Users pushed back when per-change review was removed | Batch approve must **never** remove per-item review |
| ChatGPT agent | "Take over" for logins and CAPTCHAs | A "Needs your hands (~90 s)" card |
| Duolingo | Streak freeze; a lower daily bar improved retention | "Minimum viable day"; rest days banked automatically |
| GitHub graph | Consistency made visible without guilt | Growth heatmap |
| Otta / WTTJ | Rich company context; "less soul-crushing" as an explicit goal | Company signals on cards; "more / less like this" chips |
| Jobright | Fit score shown before applying | A score broken into parts (Skills · Level · Comp · Location) |

## Anti-patterns to avoid
- A generic kanban as the home screen. After 9 months it becomes a graveyard of "Rejected" cards.
- Black-box auto-apply that fails silently.
- Vanity totals ("1,247 applied!") that read as an indictment.
- Loss-aversion streaks, red badges, countdown timers.
- Rejections shown in red or with an X. Use neutral gray "Closed" instead.
- Endless feeds. Ours is bounded and has an end.
- Confetti on every action.
- Opaque fit percentages.
- Kanban that only works by drag-and-drop.

## The three directions
- **A. Mission Control:** a calm, warm-dark command center. Keyboard-first, with an intent-preview queue and amber accent. Risk: could feel like yet another dark dev dashboard.
- **B. Momentum:** energetic and game-like (Strava × Duolingo). Swipe cards, weekly ring, coral/lime/iris palette. Risk: can feel patronising, and swiping invites rubber-stamping.
- **C. The Daily Edition:** editorial and narrative, like a morning paper about your search. Serif type, prose rationales, warm paper palette. Risk: slower to scan at volume.

## Recommendation from the research
**A as the backbone, plus C's narrative lede and prose "why", plus B's earned celebrations and forgiving streaks.** Mockups present A, B, C and this hybrid (D) for the product owner to choose from.
