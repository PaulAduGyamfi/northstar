# ADR-0002 — Approval Gate and capability-isolated Action Gateways

**Status:** Proposed · **Date:** 2026-11-24

## Context
The product owner requires human approval before anything is sent in their name (replies, outreach, short answers), while also wanting applying to be ≤ 1 click. Agents read untrusted content (job pages, emails) that may contain prompt injections. A UI-only "are you sure?" is not a control.

## Decision
1. Agents **propose**; they never hold credentials for outbound actions.
2. A deterministic **Approval Gate** turns proposals into approval items and evaluates user-defined **auto-approve policies** (e.g. "auto-submit if Fit ≥ 85, known adapter, all answers reused from bank"). Default policy: everything requires a human.
3. **Action Gateways** (Apply, Mail, Calendar, GitHub) are the only components with side-effect capability. Each call must carry an `approvalId` or `policyDecisionId` that the gateway verifies against the Gate, plus an idempotency key.
4. Approvals are immutable records and are batched in one queue (1-click batch approve).

## Consequences
- + "Nothing goes out without approval" is enforced in code and testable (RPL-002, OUT-005).
- + Prompt injection in an email can at worst produce a bad *draft*, which the user sees.
- + Autonomy is dialed per rule as trust grows, without code changes.
- − Extra hop and schema for every action; worth it.
