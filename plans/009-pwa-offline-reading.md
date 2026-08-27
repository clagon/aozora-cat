# Plan 009: Add PWA installation and reliable offline reading

> **Executor instructions**: Keep the app functional online when caching fails.
> Never evict a user's saved work silently. Test real service-worker behavior,
> not only mocked cache functions.
>
> **Drift check (run first)**: `git status --short -- static src/service-worker* src/lib/offline src/routes/other`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 005, 007, and 008
- **Category**: performance
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Opened works must remain readable through connectivity loss, and the lightweight
catalog must remain searchable. Service-worker update races and storage quotas
can otherwise erase or strand the core experience.

## Current state

Work assets are immutable/hash-addressed, catalog releases are versioned, and
reading state lives separately in IndexedDB. Works cache automatically on open;
the app never removes an older saved work merely to make space.

## Scope

**In scope**: manifest/icons, service worker, cache manager, offline catalog,
saved-work controls, update UI, quota/error handling, PWA tests.

**Out of scope**: cloud sync, background full-corpus download, custom domain,
push notifications, and unbounded cache eviction.

## Steps

### Step 1: Add installable PWA metadata

Create a valid Japanese manifest, restrained cat app icons, theme colors, and
installability metadata. Icons must be original project assets, not the Aozora
Bunko logo.

**Verify**: manifest validation and browser installability checks pass.

### Step 2: Implement cache policies

Precache the app shell and lightweight catalog. Cache each work atomically only
after body/images validate. Version caches by release; preserve explicitly
saved works and last known-good shell during failed upgrades.

**Verify**: service-worker integration tests cover first load, offline reload,
partial download, corrupt response, and release rollover.

### Step 3: Integrate offline management

Show offline status and approximate storage. Allow individual/all work removal.
On quota failure, keep online reading, retain typed user state, preserve entered
feedback, and guide the user to storage management.

**Verify**: quota-failure E2E produces the designed notice and never auto-deletes.

### Step 4: Implement app/content updates

Notify without interrupting reading. Activate on user choice or next startup
after persisting position and pending form state. Refresh an opened saved work,
migrate position, and report approximate fallback.

**Verify**: two-version E2E proves uninterrupted old-session reading and safe
next-start activation.

## Test plan

- Playwright service-worker tests in Chromium plus WebKit fallback checks.
- Network-off tests for shell, search, saved and unsaved works.
- Rights-change release invalidates body cache and creates a bookshelf tombstone.
- Lighthouse PWA checks are supplemental, not the only validation.

## Done criteria

- [ ] Installed app launches offline.
- [ ] Catalog search and previously opened works function offline.
- [ ] Unsaved work clearly requires connectivity.
- [ ] Quota and update failures preserve reading state.
- [ ] Removed/rights-changed bodies cannot remain readable after next sync.
- [ ] Global checks pass.

## STOP conditions

- Target Safari cannot support the selected cache/update behavior reliably.
- Offline correctness requires caching all 17,000+ works.
- Cache cleanup could delete user-selected data without confirmation.
- Service-worker routing conflicts with `/works/{id}#read` shareability.

## Maintenance notes

Browser storage policies change. Keep cache policy integration tests and include
service-worker/version behavior in every release review.
