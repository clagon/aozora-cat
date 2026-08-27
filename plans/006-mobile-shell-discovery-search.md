# Plan 006: Implement the mobile shell, discovery, and search

> **Executor instructions**: Implement only discovery/navigation surfaces. Use
> fixture catalog data from Plan 004 until Plan 005 artifacts are available.
>
> **Drift check (run first)**: `git status --short -- src/routes src/lib/ui src/lib/search content/features`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 002 and 004
- **Category**: direction
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Users must find a work and begin reading with minimal friction. This unit builds
the mobile-first navigation and offline-capable catalog search without mixing in
reader complexity or server-side behavioral tracking.

## Current state

Design artifacts define three tabs: Home, Bookshelf, Other. Search is a mode of
Home, not a tab. Home order is search, continue reading, seasonal feature, then
beginner works. Bookshelf content remains a placeholder until Plan 008.

## Scope

**In scope**: app layout, home/search/feature routes, catalog loader, search
ranking/filtering, shared cards, empty/loading/error states, route tests.

**Out of scope**: reader, real persistence, PWA service worker, feedback backend,
analytics, final bookshelf behavior, and corpus generation.

## Steps

### Step 1: Implement the mobile shell

Build semantic landmarks and bottom navigation matching Plan 002. Hide bottom
navigation only on the reader route contract. Preserve focus and scroll when
entering/leaving Home search mode.

**Verify**: component tests assert navigation labels, active state, focus return,
and no fourth Search tab.

### Step 2: Build Home and feature surfaces

Render conditional continue-reading placeholder, current JST feature, and
approved beginner recommendations. Expired features move to an archive; missing
current feature falls back to evergreen recommendations.

**Verify**: fake-clock tests cover before/during/after feature dates in JST.

### Step 3: Implement local catalog search

Search title, author, their readings, and subtitle. Rank exact title, title
prefix, title substring, author, then reading. Add author, orthography, and
classification filters plus relevant/title/author sort modes. Save recent query
strings locally through an interface to be implemented by Plan 008.

**Verify**: deterministic ranking tests cover Japanese text, empty queries,
duplicate contributors, and filter combinations.

## Test plan

- Component tests at 360x800 and 390x844.
- Keyboard, screen-reader-name, and focus tests for search mode.
- E2E: Home → query → result → work URL → Back restores Home and scroll.
- No requests are sent while searching a locally loaded fixture catalog.

## Done criteria

- [ ] Navigation and Home ordering match the design contract.
- [ ] Search ranking and filters are deterministic and fully tested.
- [ ] Search operates without network after catalog load.
- [ ] Loading, no-result, corrupt-catalog, and offline states exist.
- [ ] Global checks pass.

## STOP conditions

- Search requires sending queries to a server.
- Catalog payload cannot meet an agreed mobile performance budget.
- UI requires a feature absent from the versioned catalog schema.
- Shared file conflicts with an in-progress Plan 008 change.

## Maintenance notes

Do not rank by popularity or analytics. Search changes must retain explainable
ordering and must not leak recent queries outside the browser.
