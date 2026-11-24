# Design tokens & components — B · Momentum (ADR-0009)

Source of truth for the UI. Implemented as CSS variables plus a Tailwind theme in `packages/ui`. Reference mockups: [b-momentum.html](mockups/b-momentum.html).

## Color
| Token | Light | Dark (night mode) | Use |
|---|---|---|---|
| `--bg` | `#FFF8F0` | `#121018` | App canvas |
| `--surface` | `#FFFFFF` | `#1C1926` | Cards |
| `--surface-2` | `#FAF6F0` | `#252134` | Inset tiles, stat boxes |
| `--line` | `#F0E9DF` | `#2F2A40` | Dividers, ring tracks |
| `--ink` | `#1B1530` | `#F3F0FA` | Primary text, nav pill |
| `--muted` | `#6C6580` | `#A49DB8` | Secondary text |
| `--coral` | `#FF5A4E` | `#FF6F64` | Primary action, apply ring, fresh highlights (fills only) |
| `--coral-text` | `#E0362B` | `#FF8A80` | Coral used as text (AA-safe) |
| `--lime` | `#B6F24A` | `#B6F24A` | Active nav, completed quests. **Never as text on light backgrounds** |
| `--iris` | `#5B5BF7` | `#8B8BFF` | Agent voice, growth ring, links |
| `--sky` | `#3CC8F0` | `#5ED3F5` | Replies / inbox accents |
| `--success` | `#3D8A00` | `#8FD14F` | Interviews, offers, ✓ |
| `--closed` | `#8C86A0` | `#7D7690` | Closed or rejected. Neutral, **never red** |
| `--handoff` | `#7B4FE0` | `#B18CFF` | "Needs your hands" |

Application states use one color + icon + label everywhere (UX-020): found (ink) · queued (iris) · awaiting you (coral) · submitting (sky, animated) · submitted (iris solid) · replied (sky) · screen/interview (success) · offer (success + lime) · closed (closed gray) · needs hands (handoff).

## Typography
| Role | Font | Weight / size |
|---|---|---|
| Display numbers, card titles, headings | Bricolage Grotesque | 800 · 28–46px, tracking −0.02em |
| Section heads | Bricolage Grotesque | 600 · 15–18px |
| UI / body | DM Sans | 400/500/700 · 13–16px |
| Stats, timestamps, keys | Space Mono | 400/700 · 11–13px, tabular |

## Shape, space, depth
- Radius: cards 22px · hero card 26px · tiles 14px · chips/nav 999px.
- Spacing scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40.
- Shadow: `0 1px 0 #1B153010, 0 12px 30px #1B15300D` (card); `0 20px 50px #1B153022` (hero card).

## Motion
- Default spring: 250–400 ms, slight overshoot (`cubic-bezier(.34,1.56,.64,1)`); exits 180 ms ease-in.
- Ring fills and count-ups animate only on change.
- Haptics on mobile for approve, skip, celebration.
- `prefers-reduced-motion`: springs become 150 ms fades. No flying cards. Haptics stay.

## Celebration ladder (UX-031, UX-044)
| Event | Moment |
|---|---|
| Application submitted | Card flies into the ring and a small coral burst plays. Toast: "Applied N min after posting." |
| Queue cleared | "Queue clear" scene with a quiet summary |
| Reply from a human | Sky pulse on the Journey token |
| Interview booked | Full-screen, once-only celebration. "Prep plan unlocked" card |
| Offer / cert passed / project shipped | Full celebration and a shareable recap card |

Never celebrated: individual swipes, opening the app, settings changes.

## Component inventory (v1)
| Component | Notes |
|---|---|
| `PillNav` | Floating nav on desktop, bottom tab bar on mobile. 5 tabs (Today, Queue, Pipeline, Grow, Inbox) + More/⌘K |
| `CommandPalette` | ⌘K: paste job link, jump, ask "why", toggle settings, pause auto-apply |
| `InputRing` | Two concentric rings (applications, growth hours) toward weekly targets |
| `QuestList` | Weekly quests with progress and banked rest days |
| `JobCard` (hero) | Freshness tag, moat tag, title, comp, fit breakdown tiles, "Why it's a match", actions |
| `CardStack` | Swipe/keys, review lock for cards that need a look (UX-041), progress bar, power-hour mode |
| `CompactQueue` | Dense list view of the same queue (UX-042) |
| `BatchCard` | "These N match your auto-rules. Approve all?" at the end of the stack |
| `HandoffCard` | "Needs your hands (~90 s)" with deep link |
| `CrewFeed` | Agent chat bubbles (Scout, Tailor, Answerer, Inbox, Coach, Planner) with quick actions. Story/Log toggle |
| `JourneyTrack` | Funnel as tokens moving along stages. Closed tokens go to the "Learned-from" tray |
| `FitBreakdown` | Skills · Level · Comp · Location tiles with "why" popover |
| `UndoToast` | Submit undo window countdown |
| `Celebration` | The ladder above, as a single component with levels |
| `HealthDot` | System health status in the nav (RES-013) |
| `DiagnosisCard` | Leakiest stage and hypothesis status (DX-003/004) |
