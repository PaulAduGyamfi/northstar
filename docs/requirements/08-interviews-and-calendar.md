# 08 — Interviews & Calendar
Covers user ask **#12** (calendar integration for interviews, reminders, scheduled prep and review).

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| CAL-001 | M | P2 | Connect Google Calendar (OAuth). Read free/busy; create events on a dedicated "Northstar" calendar. |
| CAL-002 | M | P2 | Detect interviews from email (05) and calendar invites; create/attach an `Interview` to the application with stage, interviewers, format (phone/tech/system design/behavioral/onsite), links. |
| CAL-003 | M | P2 | **Prep blocks.** Auto-schedule prep sessions before each interview (default: 2 × 45 min in the 3 days before, 15 min warm-up 1 h before) into free time; respects working hours and the growth plan (09). User approves the plan once per interview. |
| CAL-004 | M | P2 | **Reminders**: day-before and 1-hour-before notifications with the prep brief link and join link. |
| CAL-005 | M | P2 | **Prep brief** generated per interview: company snapshot (product, funding, news, eng blog, stack), role/JD recap, interviewer backgrounds (public info), likely question types for the stage, the user's best-matching stories mapped to JD requirements, questions to ask them. |
| CAL-006 | S | P2 | **Practice mode**: mock interview chat/voice for the stage type; behavioral answers scored against STAR and the story bank; technical prompts tuned to the JD stack. |
| CAL-007 | M | P2 | **Post-interview review**: prompt within 1 h to log questions asked, how it went, follow-ups; drafts thank-you note (RPL-005); questions asked get added to a personal question bank. |
| CAL-008 | S | P3 | Spaced repetition: weak areas from reviews resurface in future prep blocks. |
| CAL-009 | S | P3 | Deadline tracking for take-homes/assessments with work blocks scheduled. |

## Acceptance criteria (selected)
- **CAL-003:** For an interview booked 4 days out, prep blocks are proposed only in free slots and appear on the calendar after one approval.
- **CAL-005:** Brief is ready ≥ 24 h before the interview (or within 1 h of booking if sooner).
