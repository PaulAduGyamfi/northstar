# Cost Model

**Status:** Estimate (2026-11-24), based on list prices and assumed usage. Not measured yet. Once the app runs, real spend per feature comes from the LLM Gateway's cost metering (NFR-CST-001, OBV-003), and this doc gets recalibrated.

## Bottom line
| Setup | Monthly |
|---|---|
| Local (docker on your machine), tiered models | **~$60–100** |
| Hosted, tiered models (recommended) | **~$100–200** |
| Hosted, Opus for everything | **~$400–500** |

Almost all of the cost is LLM usage. Infrastructure is cheap at single-user scale.

## Assumptions
- ~25 applications per weekday → ~500 / month.
- ~200 new jobs ingested per day from the watchlist → ~4,000 / month to score.
- ~30 job-related emails per day after the deterministic pre-filter (INB-002).
- ~5 reply drafts and ~5 outreach drafts per day.
- ~4 interviews per month; weekly profile scan and growth plan.

## LLM pricing used
| Model | Input $/MTok | Output $/MTok | Cache read $/MTok |
|---|---|---|---|
| `claude-opus-5-5` (default, ADR-0006) | 4.00 | 20.00 | 0.20 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 0.10 |
| `claude-haiku-5-5` | 0.10 | 0.50 | — |
| Web search tool | $10 per 1,000 searches | | |

## LLM cost by feature (monthly)
| Feature | Per-unit estimate | Volume | Opus for everything | Tiered (recommended) |
|---|---|---|---|---|
| Job scoring (MAT-001) | ~6k input (4k cached profile) + ~2k output incl. thinking ≈ $0.05 on Opus | 4,000 | ~$200 | ~$25: Haiku pre-screens all, Opus scores the top ~20% |
| Application package: tailor + answers + authenticity pass (TLR, ANS) | ~20k input (half cached) + ~6k output ≈ $0.16, ~$0.30 with critique and retries | 500 | ~$150 | ~$100–150: stays on Opus, since quality is the product |
| Inbox classification (INB-003) | ~2k input + 300 output | 900 | ~$20 | ~$1 on Haiku |
| Reply + outreach drafts (RPL, OUT) | ~$0.05–0.10 each | 250 | ~$25 | ~$25 |
| Prep briefs, mock interviews, profile scans, growth plan | — | — | ~$20 | ~$20 |
| Company research web searches | $0.01 each | ~300 | ~$3 | ~$3 |
| **Total** | | | **~$400** | **~$75–125** |

One-time: Gmail backfill of 9 months of job email (DX-001), ~$5–15.

Embeddings (pgvector): a local open-source embedding model costs $0. A hosted embeddings API costs a few dollars a month at this volume.

## Infrastructure (monthly)
| Item | Local | Hosted |
|---|---|---|
| Web + API + workers + Playwright browsers + self-hosted Temporal | $0 | ~$20–40 (one small VM / Fly / Railway machine, ~2–4 GB RAM) |
| Postgres + pgvector | $0 | $0–19 (Neon / Supabase free or entry tier) |
| Object storage (resumes, submission proofs) | $0 (MinIO) | ~$0 (Cloudflare R2 / S3 at this scale) |
| Observability: Grafana Cloud, Sentry | $0 (local LGTM) | $0 (free tiers) |
| Gmail, Calendar, GitHub APIs; web push | $0 | $0 |
| Temporal Cloud (alternative to self-hosting) | — | Has a paid monthly minimum; not recommended for one user |
| Contact finder (Hunter / Apollo) for outreach (OUT-002) | optional | ~$0–50 depending on plan. Verify current pricing before choosing (Q-06) |
| Domain | — | ~$1 |

## Cost levers (already in requirements)
1. **Tiered models.** Haiku pre-screens high-volume routes; Opus handles quality-critical ones. Only adopt a cheaper tier when an eval shows equal quality (ADR-0006).
2. **Prompt caching.** The stable prefix (system prompt → profile graph → voice guide) is billed at ~5% of normal input (NFR-CST-002).
3. **Batch API.** Nightly re-scoring and bulk work at 50% off.
4. **Effort per route.** `low` for classification and extraction, `high` only for tailoring and answers.
5. **Budget caps.** Daily and monthly LLM caps. When a cap is hit, low-priority routes pause first and fresh-job routes keep running (RES-009).
6. **Deterministic first.** ATS APIs return structured JSON (no LLM extraction needed), the inbox pre-filter is rule-based, and dedupe and policy checks are plain code.

## What moves the bill
- **Applications per day** (linear in package cost).
- **Watchlist size × poll cadence** (more fresh jobs means more scoring). The 15-minute freshness target (SRC-012) raises volume, and the Haiku pre-screen keeps that cheap.
- **Mock-interview usage** (long multi-turn sessions).

## Not included
Development cost: building with Claude Code is covered by your Claude plan, not this API budget.
