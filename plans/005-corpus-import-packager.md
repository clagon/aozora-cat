# Plan 005: Build the full catalog import and release packager

> **Executor instructions**: Build deterministic artifacts from official input.
> Do not publish, create Cloudflare resources, or commit generated corpus data.
>
> **Drift check (run first)**: `git status --short -- packages/importer content scripts tests/corpus`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/004-safe-aozora-converter.md`
- **Category**: performance
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

The service must transform roughly 17,352 copyright-expired works each week,
surface failures, stay under Cloudflare's 20,000-file and 25 MiB-per-file
limits, and reproduce exactly what a reviewer approved.

## Current state

Plan 004 converts one approved work safely. The official expanded UTF-8 CSV is
the catalog source; the `作品著作権フラグ` column is authoritative. Generated
works must not be tracked by Git.

## Scope

**In scope**: `packages/importer/**`, `scripts/corpus/**`, `content/features/**`,
`content/recommendations/**`, `tests/corpus/**`, generated-output ignore rules.

**Out of scope**: production UI, Cloudflare deployment, automatic PR creation,
private credentials, and copyright-active work bodies.

## Steps

### Step 1: Import and normalize official metadata

Download the expanded UTF-8 CSV with timeout, retry, size, and content checks.
Deduplicate by work ID while retaining all people/roles. Filter copyright-active
works before body fetch. Produce a lightweight searchable catalog.

**Verify**: integration fixtures cover duplicate author/translator rows,
missing XHTML, and copyright flags; active works cause zero body requests.

### Step 2: Fetch incrementally and reproducibly

Use bounded concurrency, conditional requests, immutable temporary staging, and
content hashes. Never overwrite the last known-good release during a failed run.
Record URL, upstream timestamps, hashes, converter version, and diagnostics.

**Verify**: a local fixture server proves retry, resume, unchanged reuse, and
failure rollback without reaching the public site.

### Step 3: Package one asset per work

Serialize metadata, semantic content, and validated images into one compressed
work asset. Split only assets above 25 MiB. Emit catalog/search shards, feature
data, provenance manifest, failure list, removed-work tombstones, and counts.

**Verify**: `pnpm corpus:validate <output>` exits 0 only when total assets are
below 20,000, every file is at most 25 MiB, and every reference resolves.

### Step 4: Produce a reviewer-facing diff

Compare current and candidate manifests. Report additions, changes, removals,
rights changes, converter failures, size changes, and schema changes. Include no
full copyrighted text or secrets in the report.

**Verify**: golden tests cover each diff category and deterministic ordering.

## Test plan

- Unit tests for CSV normalization, deduplication, filtering, hashing, packing.
- Integration tests using a fixture HTTP server; no live network in CI.
- A separately invoked read-only smoke import may sample official URLs.
- Determinism: two clean builds from the same fixture inputs have identical hashes.

## Done criteria

- [ ] Copyright-active bodies are never fetched or packaged.
- [ ] Candidate failure cannot alter last known-good output.
- [ ] Limits are machine-enforced before any deployment step.
- [ ] Diff and provenance manifests are human-reviewable.
- [ ] Generated corpus is ignored by Git.
- [ ] Global checks pass.

## STOP conditions

- Official CSV columns do not match the pinned schema.
- The normal corpus cannot fit the free asset limits without a new packing design.
- An upstream deletion or rights change cannot be represented distinctly.
- Reproducibility would require committing generated bodies to Git.

## Maintenance notes

Full live imports must be polite to the official service and should run only in
the scheduled pipeline. Review sudden corpus-size or failure-count changes.
