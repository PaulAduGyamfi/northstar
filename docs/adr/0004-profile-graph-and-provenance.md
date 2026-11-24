# ADR-0004 — Candidate Profile Graph and provenance-anchored generation

**Status:** Proposed · **Date:** 2026-11-24

## Context
Resumes, answers, replies, outreach and profile copy are all generated in the user's name. The product owner wants these based on "my real experiences" and "in my voice." Fabricated claims are a career risk (background checks, interviews that probe the claim).

## Decision
- Model the candidate as a graph of **experience atoms** (one fact each: what/how/impact/scope/dates/evidence) and **stories** (STAR narratives citing atoms), plus a **voice profile** and an **answer bank**.
- Every generator receives retrieved atoms/stories with IDs and must return output with **citations per claim** (structured output).
- A deterministic **Provenance Validator** rejects outputs with uncited factual claims or citations to non-existent IDs; the generator retries or asks the user for the missing fact.
- Locked fields (employers, titles, dates, degrees) can never be altered by generation.

## Consequences
- + Truthfulness is structural; the user can click any line to see its source.
- + Interview prep falls out for free: every claim in a resume maps to a story the user can tell.
- − Onboarding requires a richer intake (guided story interview, ~45 min once). We make that a chat, not a form.
