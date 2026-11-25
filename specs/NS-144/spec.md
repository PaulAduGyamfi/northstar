# NS-144: Resume-tailor model route for the summary and job-term wording

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: TLR-001 ("mirror JD terminology where truthful, adjust summary"), TLR-002 (every
line links to the atom it came from; lines without provenance are blocked). GitHub issue #83,
parent #16 (NS-117).
Rules that apply: ADR-0004, ADR-0006, ADR-0013, ADR-0016 item 8 (hand-written fixtures, route off
by default, provisional baseline), AGENTS.md (code decides, the model drafts; untrusted text is
data), `.claude/rules/llm.md`, `.claude/rules/tests.md`.

## Why
The deterministic tailor (NS-117) picks and orders Paul's resume lines for a job but never
rewords one and never writes a summary. TLR-001 also asks for the job's own words where they are
true, and a summary for the role. Only the model can write those, and only plain code can decide
whether what it wrote is backed by Paul's atoms.

## Behavior
All in `packages/profile/src/tailor/`.
1. **Route `resume-tailor`** (`route.ts`, prompt `packages/prompts/prompts/resume-tailor/v1.md`):
   - **Input:** the deterministic tailor's resume, the cited atoms (id, role id, resume line),
     the roles by id (title and employer, so the model knows the context; it never writes them),
     the skills, and the job's title, requirements and nice-to-haves.
   - **Untrusted blocks:** the job goes in one (it comes from an employer's page). The resume,
     atoms and skills go in another (Paul's own text, which may hold pasted material).
   - **Output:** the existing `TailoredResume` schema. Summary lines and reworded bullets each
     cite atom ids.
   - Effort `medium`, no tools.
2. **`tailorWithModel(deps, master, job, options)`** (`model-tailor.ts`):
   - **Off by default.** Without `enabled: true` it returns the deterministic resume and calls
     nothing (`{ kind: "deterministic", reason: "off" }`).
   - **When on,** it calls the route with the deterministic resume as the base. A refusal,
     truncation, invalid output or failed check falls back to the deterministic resume, with
     the reason and the validator's failures. **A failed output is never kept or returned.**
   - **The check** is `validateTailoredResume(output, master, job)` (numbers, job technology
     names, role order, added-skill flags, one-line text), plus two code rules:
     - **`notClaimed` is always the deterministic tailor's.** The model can't remove a "not
       claimed: Kubernetes" note, and can't add one.
     - **Skills must be the deterministic tailor's skills** (the same names and added flags,
       any order). Wording may change; claims may not.
     - **Structure is the deterministic tailor's:** the same sections in the same order, and the
       same atoms on each line in the same order. The model can't drop, reorder, merge or re-add
       lines; selection and the page budget stay code's (TLR-001). Only text and summary change.
     - **Model-written text names nothing new** (`checkFreeText`). Every capitalised word must
       be in the cited atoms (line, what, how), their roles' title or employer, or the master's
       skills. It is never taken from the job. A line's first word passes as an ordinary opener
       or a word those hold in lower case. A word with a capital anywhere ("eBay", "gRPC") counts
       as a name, and so does any name the job writes with a capital, in whatever case the line
       uses ("kubernetes"). Every number word must be in the cited atoms: "ten" and "billion",
       but also joined forms ("billion-row", "twenty-five") and multipliers ("tenfold",
       "quadrupled"). This closes what the validator's digit-token and term rules can't see in
       free text (an invented employer or title, "120 billion"). Failures give a word's
       position, never the text. The rule errs toward the deterministic resume.
   - Returns the call record for the caller's event. Nothing is stored.
3. **Eval** `evals/resume-tailor/`:
   - **Synthetic cases** from the NS-117 master, and a grader that runs the same check plus
     each case's `absent` words.
   - **The known limits are covered** (spec of NS-117): "120 million" upgraded to
     "120 billion" passes the digit-token check, so the case lists "billion" as absent. Also
     covered: a technology the job names that no atom has, an upgraded verb, and an
     injection in the job text.
   - **Hand-written fixtures** (written with `handwrite-bin`), each marked `handWritten`. One
     is deliberately wrong ("120 billion") to show the grader catches what the validator can't.
   - **The baseline is provisional.**
   - A `needs:paul` issue asks Paul to `--record` and set the baseline.

## Acceptance criteria
- [ ] `tailorWithModel` returns the deterministic resume without calling the gateway when
      disabled (profile tests).
- [ ] When enabled:
  - a valid model resume is returned with its record;
  - a resume naming a technology no cited atom has, a changed number, a dropped
    `notClaimed`, or an added skill falls back to the deterministic resume with the reason;
  - a refusal falls back too (profile tests with a scripted gateway).
- [ ] The route puts the job in an untrusted block with closing tags escaped (profile test).
- [ ] Prompt locked, route registered, `eval --all` replays `resume-tailor` at its provisional
      baseline. A `needs:paul` issue to record it.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Model down:** a transport error throws for the caller's retry. **Refused, truncated or
  invalid:** the deterministic resume, with the reason. Paul always has a resume.
- **The model words a claim the validator can't see** ("led" for "helped", "120 billion"):
  the eval cases cover these. Paul's review of the diff (TLR-003) is the backstop.

## Observability
`tailorWithModel` returns the `CallRecord` and the outcome for the caller's `resume.tailored`
event (NS-146). Nothing is emitted here, because nothing calls it yet.

## Out of scope
Storing tailored resumes and a command (NS-146), PDF/DOCX rendering (NS-145), and the voice
profile in summaries.
