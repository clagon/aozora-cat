# Plan 012: Automate reviewed weekly imports and Cloudflare delivery

> **Executor instructions**: Build automation but do not create resources,
> upload artifacts, open PRs, push, or deploy without explicit operator approval.
> Never place a credential in a file, command output, artifact, or PR body.
>
> **Drift check (run first)**: `git status --short -- .github/workflows scripts/deploy wrangler* docs/operations`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 005, 009, and 011
- **Category**: dx
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Weekly corpus changes must be reviewable, reproducible, rights-safe, and unable
to replace a healthy release with a broken one. Delivery must also enforce free
Cloudflare limits and preserve rollback metadata.

## Current state

Plan 005 emits candidate assets, manifest, hashes, diff, failures, and tombstones.
Plan 009 consumes versioned assets. Plan 011 defines Worker/D1 bindings. The
approved flow is scheduled PR → human review/merge → exact-input rebuild → deploy.

## Scope

**In scope**: scheduled/import/deploy workflows, provenance lock format, artifact
transfer, Cloudflare configuration, preflight checks, smoke tests, rollback and
operations docs.

**Out of scope**: creating external resources without approval, paid plans,
committing generated corpus, automatic unreviewed deploys, custom domain.

## Steps

### Step 1: Create the weekly candidate workflow

On a non-peak JST schedule, fetch and validate official metadata, build candidate
artifacts, run all corpus checks, and create/update one PR containing only a
provenance lock and concise diff report. Pin actions to immutable revisions.

**Verify**: local workflow validation and a dry-run fixture produce the expected
PR payload without contacting GitHub mutation APIs.

### Step 2: Freeze reviewed input

Record every source URL/hash/timestamp, converter version, schema version, counts,
and candidate manifest hash. On merge, re-fetch and require exact hashes; abort
if upstream changed instead of deploying unreviewed content.

**Verify**: changed-input fixture fails before packaging or upload.

### Step 3: Configure Cloudflare build and preflight

Define Workers Static Assets, Worker routes, D1 bindings, Turnstile/GitHub secret
names, environment separation, and free-tier assumptions. Fail if assets >=20,000,
any asset >25 MiB, dynamic routes capture static work requests, or secrets are absent.

**Verify**: `pnpm deploy:check` succeeds on fixtures and fails each limit fixture.

### Step 4: Deploy atomically and verify

Upload candidate version without destroying last known good, activate only after
smoke checks, retain rollback identifiers, and verify Home, search, one work,
offline manifest, and feedback health. Use the free Cloudflare subdomain.

**Verify**: deployment code has a no-network dry-run; live deploy requires an
explicit protected-environment approval and records the resulting version ID.

## Test plan

- Workflow syntax/security checks and pinned-action verification.
- Fixture candidate/update/removal/rights-change/failure scenarios.
- Exact-input mismatch, asset-limit, missing-secret, smoke-failure rollback.
- Static work requests must not consume Worker dynamic quota by routing design.

## Done criteria

- [ ] No generated work body is committed to Git or placed in a PR body.
- [ ] Merge cannot deploy input differing from reviewed hashes.
- [ ] Rights changes and removals invalidate released assets/tombstones correctly.
- [ ] Failed deploy leaves last known-good release active.
- [ ] Operations and rollback runbooks are complete.
- [ ] Global checks and dry-run deployment checks pass.

## STOP conditions

- Cloudflare limits or billing behavior differ from the recorded assumptions.
- A live mutation is required without explicit approval.
- Upstream exact-input hashes changed after approval.
- Deployment cannot be rolled back without reconstructing missing artifacts.

## Maintenance notes

Review Cloudflare and GitHub limits quarterly. Scheduled workflows can be disabled
after public-repo inactivity; document a health check for missed weekly runs.
