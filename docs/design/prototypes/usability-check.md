# UX-002 usability check: B · Momentum prototype

**Who:** Paul, alone, without help or hints. **What:** five core tasks on the clickable
prototype (`index.html` in this folder; double-click it, or open it from any static server).
**Why:** to learn before `apps/web` is built whether the B · Momentum flow is easy to read,
understand, navigate and use (requirement 12, UX-002).

## Before you start
- Use a desktop browser at full width first, then repeat task 1 on a phone-width window
  (390 px) or a real phone.
- Reload the page between tasks if you want a fresh start; the data resets on reload.
- Don't open the shortcut list (`?`) before task 1. Finding things without it is part of the test.
- Note the time when you start each task. Stop a task after 3 minutes and mark it as not done.

## The five tasks (read each one, then try it)
1. **Approve a batch.** Some applications in your queue match your auto-rules. Approve all of
   them at once, except any you'd rather look at first.
2. **Find why a job was skipped.** Scout skipped a trading-systems role at Ostrava Systems.
   Find out why.
3. **Change your comp floor.** You've decided you'd take $140k. Change your minimum pay, and
   check what that does to your queue.
4. **See what failed.** Something didn't go out on its own today. Find what happened and what
   you need to do about it.
5. **Log growth progress.** You just spent 45 minutes on a practice exam for your AWS
   certification. Record it.

## What counts as done
| Task | Done when |
|---|---|
| 1 | The batch card's Approve is pressed and the undo countdown runs out (or a toast says "Applied to N roles"). |
| 2 | The "Why Scout skipped it" panel for Ostrava Systems is open. |
| 3 | The toast says "Comp floor is now $140k" and the queue count goes up by one. |
| 4 | The paused Bluepine Capital step is open (crew feed, health dot or Needs-your-hands card). |
| 5 | Grow shows 6.3 of 8 hours this week. |

## Results (Paul fills this in)
| Task | Done without help? | Time | Where I hesitated | What I'd change |
|---|---|---|---|---|
| 1. Approve a batch | | | | |
| 2. Why skipped | | | | |
| 3. Comp floor | | | | |
| 4. What failed | | | | |
| 5. Log growth | | | | |
| 1 again, phone width | | | | |

**Overall:** does it feel easy, and not boring? Anything that felt like rubber-stamping, guilt
or noise?

## After the check
- Every task done without help: UX-002 passes. Record the date here and in the NS-107 PR.
- A task not done: say why in the table. Fix it in the NS-107 PR or open a follow-up issue,
  whichever Paul prefers.

## Already checked by the agent (not a substitute for this check)
- Every task done with the keyboard only and with the mouse only, in headless Chrome.
- The review lock: a card with a new narrative answer opens for review when you press A or
  swipe it, and only goes out from the review.
- WCAG AA contrast for every text and background pair the prototype uses, in both themes.
