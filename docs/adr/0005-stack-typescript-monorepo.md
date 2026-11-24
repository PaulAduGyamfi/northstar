# ADR-0005 — TypeScript monorepo

**Status:** Proposed — confirm with product owner (Q-04) · **Date:** 2026-11-24

## Decision
- **pnpm + Turborepo** monorepo, TypeScript everywhere.
- **Web:** Next.js (App Router) as a PWA; Tailwind + shadcn/ui.
- **API:** Next.js route handlers or a separate Fastify app (`apps/api`) for webhooks/extension bridge; tRPC or typed REST with Zod.
- **Workers:** Temporal TypeScript SDK; **Playwright** for ATS adapters.
- **Extension:** Chrome MV3 (Plasmo or WXT).
- **DB:** Postgres 16 + pgvector; **Drizzle** ORM + migrations.
- **LLM:** `@anthropic-ai/sdk` behind the LLM Gateway (ADR-0006).
- **Storage:** S3-compatible (SeaweedFS locally; NS-104 replaced MinIO, which stopped publishing community images).
- **Docs rendering:** react-pdf or a headless-Chrome HTML→PDF template for resumes.

## Why
One language across browser, extension, server and Playwright; Zod schemas shared between structured LLM outputs, API and UI; the product owner is a full-stack engineer and can contribute anywhere.

## Alternatives
- Python workers (richer scraping/ML ecosystem) + TS frontend: splits types and skills; not needed — the heavy lifting is LLM calls and Playwright, both first-class in TS.
- Java/Spring (product owner's Mastercard background): strong, but slower iteration for this shape of product.
