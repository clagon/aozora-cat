# Plan 002: Define mobile wireframes and design contracts

> **Executor instructions**: Produce implementation-ready design artifacts,
> not production screens. Do not invent new product features. Run the drift
> check and stop when an agreed screen or behavior conflicts with this plan.
>
> **Drift check (run first)**: `git status --short -- docs/design src/lib/ui`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-bootstrap-sveltekit-foundation.md`
- **Category**: direction
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

The reader depends on gesture zones, hidden chrome, vertical typography, and
mobile navigation that are expensive to reinterpret after implementation.
Wireframes and tokens give later executors one visual contract.

## Current state

Plan 001 provides only a smoke UI. The agreed navigation is `ホーム`, `本棚`,
`その他`; the reader hides navigation. The brand is quiet paperback styling:
ink, unbleached paper, restrained blue, and a small cat motif outside reading.

## Commands you will need

Use the global commands from `plans/README.md`.

## Scope

**In scope**: `docs/design/**`, `src/lib/ui/tokens.css`, optional static SVG
wireframes/icons under `docs/design/assets/`.

**Out of scope**: functional routes, final logo artwork, remote images,
generated raster assets, backend code, and corpus data.

## Steps

### Step 1: Document the information architecture

Create `docs/design/information-architecture.md` covering routes, navigation,
empty/loading/offline/error states, and transitions for home search mode, work
details, reader, bookshelf, and settings.

**Verify**: the document names all six key surfaces and contains no separate
top-level search tab (`rg 'ホーム|本棚|その他|検索モード|作品情報|読書' docs/design`).

### Step 2: Draw mobile wireframes

Create accessible text/SVG wireframes for 390x844 and 360x800 viewports:
home, search mode, work details, vertical reader, bookshelf, and other/settings.
Include first-use overlay, removed-work tombstone, storage-full notice, and
offline state. Show tap zones without placing controls over text.

**Verify**: every artifact opens locally and all text remains legible at 200%.

### Step 3: Define tokens and component contracts

Document color, type, spacing, focus, motion, tap-target, and theme tokens.
Implement only token variables in `tokens.css`. Text uses system serif; UI uses
system sans. Define white, paper, and night themes; all targets are at least
44 CSS pixels; reduced motion must be supported.

**Verify**: `pnpm lint && pnpm check` exit 0; an automated contrast calculation
or documented manual table shows WCAG 2.2 AA for every foreground/background.

## Test plan

- Add a token contract unit test if tokens are exposed to code.
- Review wireframes at both required viewport sizes and 200% text scaling.
- Keyboard-order annotations must exist for every interactive wireframe.

## Done criteria

- [x] Six primary mobile wireframes and required edge states exist.
- [x] Tokens cover three themes and four text sizes.
- [x] Reader contains no cat decoration or persistent navigation.
- [x] Search is a home mode, not a fourth navigation item.
- [x] Global checks pass with no production feature implementation.

## STOP conditions

- A screen requires an account, server-side reading history, or deferred MVP feature.
- A contrast or tap-target requirement cannot be met without changing the visual direction.
- The operator requests high-fidelity branding; split that into a separate design plan.

## Maintenance notes

Later UI plans must treat these artifacts as contracts. Any deliberate change
must update the affected wireframe and token documentation in the same unit.
