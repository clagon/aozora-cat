# Plan 008: Implement local reading state and the bookshelf

> **Executor instructions**: All reading behavior in this plan remains in the
> browser. Do not add accounts, identifiers, synchronization, or telemetry.
>
> **Drift check (run first)**: `git status --short -- src/lib/storage src/routes/bookshelf src/routes/other src/lib/reader`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 006 and 007
- **Category**: direction
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

The MVP promise includes resuming a work, finishing it, and managing a personal
bookshelf without logging in. A versioned local model must survive layout and
content updates while remaining deletable and private.

## Current state

Plan 007 exposes typed hooks for positions, statuses, favorites, and settings.
Required local data: paragraph/character position, history, favorite, unread /
reading / completed, four text sizes, three themes, writing direction, recent
searches, first-use flags, and removed-work acknowledgement.

## Scope

**In scope**: `src/lib/storage/**`, bookshelf routes/components, Other data
management UI, reader/catalog adapter integration, migration tests.

**Out of scope**: work-body offline cache, service worker, cloud sync, export /
import, server persistence, analytics, and automatic deletion of user choices.

## Steps

### Step 1: Define a versioned IndexedDB model

Separate user state from cacheable corpus data. Validate every read, migrate in
transactions, and expose repository interfaces rather than direct IndexedDB use
from components. Provide a memory adapter for tests and unavailable-storage mode.

**Verify**: migration tests cover empty, current, previous, corrupt, and aborted
transactions without losing recoverable records.

### Step 2: Integrate reading lifecycle

Persist anchors at bounded intervals and on lifecycle events. Mark reading on
first progress and completed on final-page arrival; permit manual status change.
Restore by paragraph/context and fall back to stored percentage with notice.

**Verify**: E2E reload, font change, orientation change, and revised-work tests
return to the intended paragraph.

### Step 3: Implement Bookshelf

Build Reading first, Favorite and Completed tabs, plus History and Offline
auxiliary screens. Removed works remain as title/author/status tombstones with
official card link when available and manual dismissal.

**Verify**: component tests cover empty states, overlaps, sorting, removal, and
an upstream-rights-change fixture whose body is no longer accessible.

### Step 4: Implement local-data controls

Add history deletion, offline-management placeholder for Plan 009, full reset,
storage usage display, recent-query individual/all deletion, and clear warnings.

**Verify**: destructive actions require confirmation and affect only named data.

## Test plan

- Repository contract runs against memory and real browser IndexedDB.
- Multi-tab update handling and interrupted transaction tests.
- No network requests during storage operations.
- E2E history, favorite, completion, manual status, tombstone, full reset.

## Done criteria

- [ ] No reading state is written outside browser storage.
- [ ] Position restoration meets Plan 007's adapter contract.
- [ ] Bookshelf and all deletion controls match the design contract.
- [ ] Corrupt/unavailable storage degrades without blocking online reading.
- [ ] Global checks pass.

## STOP conditions

- A requirement appears to need a stable user/device identifier.
- Migration cannot preserve valid existing positions.
- Shared files conflict with concurrent Plan 010 work.
- Full reset leaves any reading/search record behind.

## Maintenance notes

Future synchronization must be a separate opt-in design. Do not make current
local IDs or schemas into an accidental public sync protocol.
