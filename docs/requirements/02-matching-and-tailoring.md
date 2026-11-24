# 02 — Matching, Scoring & Resume Tailoring
Covers user ask **#3** (fix up resume, tune it per position) and the scoring that gates auto-apply.

## Requirements

### Candidate Profile Graph (the source of truth)
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| CPG-001 | M | P1 | Import master resume (PDF/DOCX), LinkedIn export, GitHub repos, personal site. Parse into structured records: roles, bullets, projects, skills, education, certifications, links. |
| CPG-002 | M | P1 | **Experience atoms.** Each bullet/project becomes an atom with: what, how (stack), impact (metric if real), scope, dates, evidence link. Atoms are the only material generators may use (ADR-0004). |
| CPG-003 | M | P1 | **Story bank.** Guided interview (chat) turns atoms into STAR stories in the user's own words; tagged by competency (leadership, conflict, ambiguity, scale, failure…). |
| CPG-004 | S | P1 | Facts the system must never change: employers, titles, dates, degrees. Locked fields. |

### Resume quality ("fix up")
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| RES-001 | M | P1 | **Resume audit.** Score master resume on: impact density (metrics per bullet), verb strength, ATS parseability, length, keyword coverage vs. target-role corpus, consistency (tense, dates). Output line-level suggestions. |
| RES-002 | M | P1 | User accepts/rejects each suggestion; accepted changes update the master and the atoms. |
| RES-003 | S | P2 | Prompt the user for missing metrics ("You migrated payments to X — how many TPS / what latency change?") rather than inventing them. |

### Job scoring
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| MAT-001 | M | P1 | Every ingested `Job` gets a **Fit Score (0–100)** with a breakdown: title/seniority fit, must-have skills coverage, nice-to-have coverage, preference fit (comp, location, stage), and "stretch" flag. |
| MAT-002 | M | P1 | Breakdown is explainable: lists matched requirements with the atom that satisfies each, and unmatched requirements. |
| MAT-003 | M | P1 | User-configurable thresholds: ≥ A → auto-queue; B–A → suggest; < B → skip (reason logged). |
| MAT-004 | S | P2 | Scoring calibrates from user overrides (applied anyway / rejected suggestion) and from outcomes (which scores led to responses). |
| MAT-005 | S | P2 | Unmatched requirements are aggregated across jobs and sent to the Growth Tracker as **skill-gap signals** (see 09, GRW-008). |

### Tailoring
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| TLR-001 | M | P1 | For each queued job, generate a tailored resume: reorder/select atoms, mirror JD terminology where truthful, adjust summary, keep 1 page (configurable). |
| TLR-002 | M | P1 | **Provenance.** Every line in the tailored resume links to the atom it came from. Lines without provenance are blocked. |
| TLR-003 | M | P1 | **Diff view.** Show changes vs. master; added skills highlighted with keep/remove toggles (ApplyASAP parity). |
| TLR-004 | M | P1 | **Pre-send score**: title match, keyword coverage (e.g. 19/22), ATS-parse check by re-parsing the rendered PDF. |
| TLR-005 | M | P1 | Render to clean ATS-safe PDF + DOCX from a template; versioned and stored per application. |
| TLR-006 | S | P1 | Cover letter generation only when the application asks, same provenance rules. |

## Acceptance criteria (selected)
- **TLR-002:** A test fixture where the JD demands a skill absent from all atoms produces a resume that does *not* contain it and a note "not claimed: Kubernetes (no evidence)."
- **TLR-004:** Rendered PDF re-parsed by our own parser recovers ≥ 95% of the text and all section headers.
- **MAT-002:** Clicking any score component shows the exact evidence used.
