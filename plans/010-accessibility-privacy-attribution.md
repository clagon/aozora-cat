# Plan 010: Add accessibility, privacy, attribution, and analytics

> **Executor instructions**: This unit turns agreed policy into visible,
> testable behavior. Do not make legal guarantees beyond documented product
> behavior; flag wording requiring professional legal review.
>
> **Drift check (run first)**: `git status --short -- src/routes/other src/lib/analytics src/lib/ui docs/policy`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 006, 007, and 008
- **Category**: security
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

A public reader must make its unofficial status, source provenance, local-data
behavior, telemetry boundaries, and accessibility commitments explicit. These
must be enforced in code rather than existing only as prose.

## Current state

Analytics is limited to general Home/Feature/Other screens. Work details,
reader, bookshelf, and search mode are excluded. Users can separately disable
anonymous analytics and automatic error reports. No search query or reading
history leaves the browser.

## Scope

**In scope**: policy/about/help/accessibility routes, attribution components,
analytics gate, error-consent settings contract, accessibility fixes/tests,
historical-expression notice, licenses generation.

**Out of scope**: feedback transport, legal counsel, account terms, reader
feature expansion, behavioral analytics, cookie identifiers, or A/B testing.

## Steps

### Step 1: Publish policy and source information

Add Japanese privacy, source/relationship, disclaimer, feedback-data,
accessibility, and OSS license pages. State that Aozora Cat is unofficial. Show
official cards, base edition, input/proofread credits, conversion provenance,
historical-expression notice, and upstream terms links.

**Verify**: route tests assert every required disclosure and link is reachable.

### Step 2: Implement telemetry boundaries

Integrate Cloudflare Web Analytics only on allowed general screens and only when
enabled. Do not initialize it on excluded routes. Implement separate local
preferences for analytics and automatic error reporting, both disableable.

**Verify**: E2E request interception proves zero analytics requests from work,
reader, bookshelf, and search mode, and after opt-out.

### Step 3: Complete WCAG 2.2 AA checks

Audit semantic structure, names, focus order, keyboard paging, zoom/reflow,
contrast, target size, reduced motion, status announcements, and image text.
Ensure horizontal mode remains a semantic fallback for assistive technology.

**Verify**: automated accessibility checks pass plus documented manual WebKit /
VoiceOver-equivalent and Chromium/TalkBack-equivalent checks.

### Step 4: Generate dependency notices

Generate reproducible third-party notices in CI and expose them under Other.
Keep AGPL-3.0 app licensing separate from source-work and metadata attribution.

**Verify**: notice generation exits 0 and fails for a dependency lacking license metadata.

## Test plan

- Route disclosure/link tests.
- Analytics allow/deny matrix with request interception.
- axe or equivalent automated checks plus keyboard and screen-reader checklist.
- 200% zoom and three-theme contrast tests.

## Done criteria

- [ ] All policy surfaces are accessible from Other.
- [ ] Telemetry exclusions are enforced by tests.
- [ ] Analytics and automatic error reporting have separate opt-outs.
- [ ] Required source attribution is never hidden behind network access.
- [ ] WCAG 2.2 AA target has automated and manual evidence.
- [ ] Global checks pass.

## STOP conditions

- Analytics cannot exclude detailed routes or avoid stable identifiers.
- A dependency license conflicts with AGPL distribution.
- Policy wording claims legal compliance that the implementation cannot prove.
- Accessibility would require changing a settled reader interaction; report it.

## Maintenance notes

Update disclosures whenever telemetry, storage, feedback fields, or providers
change. Policy drift is a release blocker, not documentation cleanup.
