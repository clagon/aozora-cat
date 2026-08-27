# Plan 003: Prove vertical pagination with representative works

> **Executor instructions**: This is a technical spike. Do not build the real
> reader or silently choose a browser-specific workaround. Record failures and
> keep only the minimal reproducible harness and decision document.
>
> **Drift check (run first)**: `git status --short -- prototypes docs/decisions tests/fixtures`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001 and 002
- **Category**: direction
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Vertical writing, ruby, CSS fragmentation, viewport changes, and touch paging
behave differently in WebKit and Chromium. The whole product depends on stable
page boundaries and position restoration, so this risk must be resolved before
the production reader is designed around an unproven technique.

## Current state

No pagination implementation exists. Required behavior: one viewport per page,
left swipe/tap advances, right returns, center toggles chrome; horizontal mode
uses vertical scrolling. Position identity is paragraph plus character offset.

## Scope

**In scope**: `prototypes/vertical-reader/**`, `tests/fixtures/reader/**`,
`docs/decisions/vertical-pagination.md`, `docs/editorial/first-readers.md`.

**Out of scope**: production reader routes, local persistence, PWA caching,
full-corpus parsing, and final recommended-work publication.

## Steps

### Step 1: Select representative official works

Research copyright-expired Aozora Bunko works and propose a compact fixture set
covering short/long prose, heavy ruby, gaiji, indentation, page breaks, images,
and old markup. Record official card URLs and why each fixture exists. Include
a separate 8–12 work beginner recommendation list for operator approval.

**Verify**: every fixture has an official card URL and copyright flag evidence;
no copyright-active work is downloaded.

### Step 2: Implement competing pagination approaches

Build a disposable route/harness comparing at least CSS columns and measured
page offsets. Preserve semantic DOM order. Exercise four font sizes, three
themes, orientation changes, and vertical/horizontal switching.

**Verify**: automated tests assert no skipped/duplicated paragraph markers at
page boundaries and restored anchors remain within the intended paragraph.

### Step 3: Verify actual engines and record the decision

Run Playwright WebKit and Chromium plus the closest available real-device or
remote-device check for iPhone Safari and Android Chrome. Record browser
versions, failures, screenshots outside the repository when requested, and the
chosen algorithm with rejected alternatives.

**Verify**: `pnpm test:e2e -- --project=webkit` and Chromium equivalent pass;
the decision document contains explicit acceptance results for both platforms.

## Test plan

- Boundary tests: ruby split avoidance, image-only page, long unbroken string,
  blank lines, page-break annotations, orientation and font changes.
- Gesture tests: horizontal threshold, vertical-scroll rejection, edge tap,
  center tap, reduced motion, keyboard equivalents.
- Position tests: forward/back round-trip and paragraph-offset restoration.

## Done criteria

- [ ] One approach passes the agreed WebKit and Chromium matrix.
- [ ] No content is skipped, duplicated, or reordered in fixtures.
- [ ] A production-facing API contract is documented without production code.
- [ ] Beginner-work candidates are ready for human approval.
- [ ] Global checks pass.

## STOP conditions

- Neither approach preserves content across both browser engines.
- Testing is limited to desktop emulation with no credible mobile-engine check.
- A workaround requires inaccessible duplicate DOM or rasterized text.
- Fixture licensing cannot be verified from official metadata.

## Maintenance notes

Keep the harness as a regression laboratory, but production code must live in
Plan 007. Re-run the matrix when SvelteKit or target browser engines change.
