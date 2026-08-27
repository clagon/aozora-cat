# Plan 013: Qualify and release the public beta

> **Executor instructions**: This plan is verification-first. Do not waive a
> failing gate to meet a date. Production deployment, public announcement, or
> issue creation requires explicit operator approval.
>
> **Drift check (run first)**: `git status --short` and compare every changed
> path with the completed-plan index. Unexplained changes are a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001 through 012
- **Category**: tests
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

The beta is acceptable only if a user can discover, start, resume, and finish a
work on both target mobile browsers without losing text or private state. This
unit gathers evidence and blocks release on safety, rights, accessibility,
offline, feedback, or operations regressions.

## Current state

All feature plans must be marked DONE. The beta starts on a free Cloudflare
subdomain. Success is quality-based, not user-count or reading-behavior based.

## Scope

**In scope**: final test fixtures/scripts, `docs/qa/**`, release checklist,
known-issues document, beta metadata, production-readiness fixes strictly needed
to satisfy already agreed gates.

**Out of scope**: new features, custom domain, 1.0 designation, analytics
expansion, paid capacity, or bypassing approval for external actions.

## Steps

### Step 1: Reconcile every plan and run the full pipeline

Confirm statuses and done criteria, then run clean install, checks, unit/E2E,
build, corpus fixture/full validation, and deployment dry-run. Record versions
and reproducible commands.

**Verify**: every command in the global verification contract exits 0 from a
clean checkout; no TODO/BLOCKED P1 plan remains.

### Step 2: Run the content fidelity matrix

Read representative short, long, image-heavy, ruby-heavy, gaiji, indentation,
and legacy works end to end in vertical and horizontal modes, all sizes/themes.
Compare structured source markers and attribution with official cards.

**Verify**: signed QA checklist shows no missing, duplicated, or reordered content.

### Step 3: Run target-browser journeys

On iPhone Safari and Android Chrome equivalents, test discover → details → read
→ offline → resume → complete, rotation/reflow, update, storage full, removed
work, feedback queue, reset, keyboard/screen reader, and reduced motion.

**Verify**: evidence records device/browser versions and each required outcome;
automated emulation alone is insufficient.

### Step 4: Run security/privacy/operations checks

Verify sanitizer fixtures, CSP/headers, no secrets, analytics exclusions,
Turnstile, rate limits, D1/GitHub redaction, weekly diff review, exact-input
abort, rollback, quota failure, and attribution/policies.

**Verify**: security checklist has zero unresolved critical/high items and no
reading/search data in network captures.

### Step 5: Prepare the beta release

Write release notes, limitations, known issues, feedback path, and 1.0 criteria.
Only after explicit approval, run the protected deployment and smoke checks.

**Verify**: production URL passes smoke checks and rollback remains available.

## Test plan

- Full global suite from a clean checkout.
- Cross-browser, accessibility, privacy-network, offline/update, and full-corpus
  validation matrices described above.
- At least two rehearsal weekly imports before considering 1.0.

## Done criteria

- [ ] Every P1 plan is DONE with evidence.
- [ ] Both target mobile browsers complete the core journey.
- [ ] All agreed content, rights, privacy, accessibility, and offline gates pass.
- [ ] Public beta limitations and known issues are documented.
- [ ] Operator explicitly approved any live production deployment.

## STOP conditions

- Any body/position loss, copyright-active distribution, or unsafe markup occurs.
- Target-browser or accessibility evidence is unavailable.
- Feedback secrets/data appear in logs or client responses.
- Deployment cannot preserve or restore last known-good state.
- The requested action would publicly deploy or announce without approval.

## Maintenance notes

Promote to 1.0 only after 30 days without a critical body/position/rights
incident, two successful production-equivalent weekly updates, stable full-corpus
validation, and no unresolved major accessibility issue.
