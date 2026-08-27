# Plan 007: Implement work details and the reading experience

> **Executor instructions**: Implement the production reader using only the
> pagination decision proven in Plan 003 and the semantic schema from Plan 004.
> Never fall back to raw HTML rendering.
>
> **Drift check (run first)**: `git status --short -- src/routes/works src/lib/reader src/lib/ui`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 003, 004, and 006
- **Category**: direction
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

This is the product's core: a quiet, faithful, mobile reading flow that works
with vertical Japanese text and preserves source information.

## Current state

The work URL contract is `/works/{id}` for details and `#read` for reader mode.
Vertical mode is paged; horizontal mode scrolls vertically. Chrome is hidden,
center tap toggles it, and edge gestures move pages.

## Scope

**In scope**: work route, semantic renderer, pagination adapter, gesture/keyboard
controls, reader chrome, themes/text sizes/writing direction, progress display,
first-use overlay, source/attribution panel.

**Out of scope**: persistence implementation, service worker, feedback backend,
analytics, data importer, annotations, TTS, notes, and highlights.

## Steps

### Step 1: Render work details and attribution

Show title, authors/translators, read/continue action contract, favorite action
contract, and full expandable bibliography including source card, base edition,
input/proofread credits, upstream update, and converter version.

**Verify**: fixtures prove no attribution field is silently omitted.

### Step 2: Render the semantic document

Map every allowed schema node to semantic Svelte components. Support ruby,
emphasis, indentation, headings, breaks, notes, captions, gaiji, and responsive
images. Unknown schema versions render a safe recovery screen.

**Verify**: converter fixture golden render tests pass with no `{@html}` sink for
upstream content.

### Step 3: Integrate production pagination and controls

Use the Plan 003 adapter. Implement left swipe/tap next, right previous, center
chrome toggle, keyboard equivalents, reduced motion, page/total and percentage,
orientation reflow, and all theme/text/writing-mode combinations.

**Verify**: WebKit and Chromium suites cover boundaries and gesture conflicts.

### Step 4: Expose persistence hooks

Emit paragraph/character anchors, reading status transitions, and settings
changes through typed interfaces. Supply an in-memory adapter until Plan 008.

**Verify**: adapter contract tests prove reload and reflow restoration semantics.

## Test plan

- Unit tests for every semantic node and unknown-version handling.
- Component tests for first-use overlay and auto-hiding chrome.
- E2E complete one short work in vertical and horizontal modes.
- Accessibility tests for semantic order, keyboard paging, zoom, and images.

## Done criteria

- [ ] Representative works render without missing/reordered content.
- [ ] All 24 theme/text-size/writing-mode combinations are exercised.
- [ ] iPhone WebKit and Android Chromium matrices pass.
- [ ] Reader URL is shareable without embedding private progress.
- [ ] Global checks pass.

## STOP conditions

- Implementation diverges from the proven pagination algorithm.
- A source construct requires unsafe HTML.
- Browser behavior loses or duplicates text at a page boundary.
- Persistence would require encoding reading position in the shared URL.

## Maintenance notes

Keep pagination behind an adapter and semantic rendering independent from page
measurement. Re-run the spike fixtures for browser or font-engine upgrades.
