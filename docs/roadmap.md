# Roadmap

Each phase ends with something you use daily. Estimates assume one engineer + coding agents, part-time.

## P0 — Foundations (now)
- [x] Requirements, architecture, ADRs (this repo)
- [x] UI direction chosen: B · Momentum (ADR-0009); tokens + component inventory
- [ ] Clickable B prototypes: Queue (stack + compact), Pipeline, Growth, Diagnostics, Settings, for the UX-002 usability check
- [ ] Resolve open questions Q-02, Q-04, Q-06…Q-11, Q-13…Q-15
- [ ] Monorepo scaffold, docker compose (Postgres+pgvector, Temporal, MinIO), CI, LLM Gateway skeleton, event outbox + feed

## P1 — Core loop: "paste a link, get an application" (~3–4 weeks)
- Candidate Profile Graph import + guided story interview (CPG-*)
- Resume audit (RES-001/002)
- Link ingest + extension capture (SRC-001/002); ATS board polling for a starter watchlist (SRC-003)
- Scoring with evidence (MAT-001..003)
- Tailoring with provenance + diff + pre-send score (TLR-*)
- Answer bank + voice profile v1 (ANS-001..008)
- Apply Gateway: Greenhouse, Lever, Ashby adapters + human handoff (APPLY-001..010)
- Approval queue + activity feed + run inspector (APR-*, OBS-*)
- Gmail read + pipeline linking with origin attribution: tagged applicant address, deterministic matching, origin labels in Gmail (INB-001 read, INB-002, INB-004 link, INB-007…012, VER-007)
- **Exit:** 20 real applications submitted with ≤ 1 click each; every one traceable end-to-end, and every reply lands on the right application marked "Started by Northstar".

## P2 — Inbox, pipeline, interviews, growth (~3–4 weeks)
- Gmail triage, type labels, status updates from email, recruiter grading, reply drafts, unified inbox view (INB-003, INB-004 status, INB-005, INB-006, RPL-*, REC-*)
- Pipeline dashboard + Today view (DSH-*)
- Calendar + interview workflow + prep briefs (CAL-*)
- Growth tracker with weekly planner and balance rules (GRW-001..007)
- Workday + SmartRecruiters adapters; liveness checks
- **Exit:** you stop opening Gmail to manage the search; weekly plan lands on your calendar.

## P3 — Reach (~2–3 weeks)
- Outreach: people + contact discovery, warm-path, drafts, sequencing (OUT-*)
- Profile scanner, grade, fix drafts, footprint checklist (PRF-*, GRD-*, VIS-*)
- Skill-gap loop + proof-of-work flywheel (GRW-008/009)
- **Exit:** profile grade baseline → +20; first inbound recruiter attributable to changes.

## P4 — Compounding
- Outcome analytics and variant recommendations; score calibration
- Speed mode for dream companies; hidden-job signals
- Broader ATS coverage; mobile polish; optional multi-tenant
