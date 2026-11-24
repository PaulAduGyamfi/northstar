# Open Questions for the Product Owner

| ID | Question | Why it matters | Default if unanswered |
|---|---|---|---|
| Q-01 | Product name? | Repo, extension, labels in Gmail. | "Northstar" |
| Q-02 | Personal tool only, or a product for other job seekers later? | Multi-tenancy, auth, billing, data isolation, and how hard we lean on ToS-sensitive features. | Single-tenant, but no single-user shortcuts in the data model (every row has `candidate_id`). |
| ~~Q-03~~ | **Resolved 2026-11-24:** "AI detection" = answers that don't read as AI-written. ADR-0003 accepted. | | |
| Q-04 | Stack OK? TypeScript monorepo (Next.js, Temporal, Playwright, Postgres/pgvector). | Everything downstream. | ADR-0005 as written. |
| ~~Q-05~~ | **Resolved 2026-11-24:** target roles, comp, locations etc. are live settings, editable any time in the app (SRC-017). Initial values are entered during onboarding. | | |
| Q-06 | Budget for paid services: Claude API (~est. $30–150/mo at 25 applies/day), contact finder (Hunter/Apollo), hosting. | Model tiering and which providers we integrate. | Claude only; contact finding via pattern inference until a provider is chosen. |
| Q-07 | Starting autonomy: everything queued for approval, or auto-submit above a score from day one? | Default policy in the Approval Gate. | Everything queued for the first 2 weeks, then review the auto-approve dial together. |
| Q-08 | Daily application cap you're comfortable with? | Reputation and quality vs. volume. | 25/day. |
| Q-09 | Growth tracker details: weekly hours available; target dates (e.g. SAA exam date); what "production hardening" means for Scripture Challenge; Backpocket's repo and current milestone; why Countersign is backlogged and when to revisit. | Planner can't balance without capacity and goals. | 8 h/week, WIP 3 (Backpocket, SAA, FDE pathway in focus; Scripture Challenge in maintenance; Countersign backlogged). |
| Q-10 | Where should this run — your machine first, or hosted from the start? Gmail push needs a public endpoint. | Deployment & P2 timing. | Local first (polling), hosted at P2. |
| Q-11 | Which email account(s) and calendar? Separate job-search Gmail or your main one? | OAuth scopes, privacy filtering. | Main Gmail with job-only pre-filter. |
| ~~Q-12~~ | **Resolved 2026-11-24:** all differentiators D-01…D-12 accepted; freshness (D-01) is the top sourcing priority. D-13…D-17 proposed. | | |
| Q-13 | **9-month funnel numbers** (rough is fine): # applications, # any human response, # recruiter screens, # technical rounds, # onsites/finals, # offers; roles/levels targeted; channels (cold / referral / recruiter); remote/location constraints; comp you've quoted; any feedback received. | Tells us *which stage* is leaking before we prescribe fixes (13-search-diagnostics). | The app backfills this from Gmail (DX-001), but your numbers let us start diagnosing now. |
| Q-14 | Confirm your **official end date** at Mastercard (from HR or separation paperwork) and what your resume and LinkedIn currently show. | Date inconsistencies can fail background checks late in the process (DX-011). | Use the official HR date everywhere. |
| Q-15 | Can you share the current resume (PDF/DOCX) and LinkedIn URL? Put the file in `data/` (gitignored), never in the repo. | Baseline for resume audit, recruiter-eye simulation, profile grade. | — |
| Q-16 | Which password manager gets the mirrored tenant passwords: **Bitwarden** or **1Password**? | CRD-004 integration (CLI or service account). | Bitwarden CLI |
| ~~Q-17~~ | **Resolved 2026-11-24:** license Apache-2.0; CI, branch protection and commit checks added (NS-101); tickets are GitHub Issues; Paul works in auto mode and oversees; toolchain per ADR-0011; Gmail weekly reconnect is acceptable for now; agents build and label eval sets. | | |
