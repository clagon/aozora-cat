# Plan 004: Build the safe Aozora conversion core

> **Executor instructions**: Treat all upstream HTML and text as untrusted
> input. Preserve information; never render raw upstream markup. Stop on an
> unknown construct instead of silently dropping it.
>
> **Drift check (run first)**: `git status --short -- packages/converter src/lib/domain tests/fixtures`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001 and 003
- **Category**: security
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

All reader fidelity, safety, pagination, offline use, and update migration rely
on one deterministic intermediate representation. A strict converter prevents
upstream scripts/styles or malformed legacy markup from crossing into the app.

## Current state

The spike supplies verified fixtures and a pagination-facing document contract.
Official XHTML is preferred; text notation is fallback. Only rows whose work
copyright flag is `なし` may become distributable content.

## Scope

**In scope**: `packages/converter/**`, `src/lib/domain/work.ts`, converter unit
and golden tests, fixture metadata already approved in Plan 003.

**Out of scope**: network crawling of the full corpus, UI rendering, deployment,
server-side HTML passthrough, and manual editorial rewriting.

## Steps

### Step 1: Define a versioned work schema

Model work metadata, people and roles, source provenance, ordered semantic
blocks, inline ruby/emphasis/gaiji, images, notes, paragraph anchors, and
bibliographic information. Impossible states must be excluded by tagged unions.

**Verify**: schema/type tests reject missing provenance, copyright-active flags,
unknown block kinds, and invalid image references.

### Step 2: Convert XHTML/legacy HTML by allowlist

Parse without executing markup. Allow only the agreed semantic constructs;
remove scripts, event attributes, forms, embeds, upstream styles, and unapproved
links. Fetch/validate image references through an explicit importer boundary.

**Verify**: security fixtures prove active content and unsafe URLs cannot appear
in serialized output; unknown semantics produce a typed conversion failure.

### Step 3: Add Aozora text fallback

Implement required notation for approved fixtures: ruby, gaiji, emphasis,
indentation, headings, page breaks, images, captions, and notes. Preserve the
original source reference and record which converter path was used.

**Verify**: golden tests compare normalized semantic output, not raw whitespace.

### Step 4: Add stable anchors and migrations

Derive stable paragraph IDs from structural context and retain surrounding text
needed for position migration. Version serialized output and implement a reader
that rejects unsupported future versions cleanly.

**Verify**: fixture edits prove paragraph/character restoration and percentage
fallback behavior required by the product decision.

## Test plan

- Happy cases for every allowed semantic node.
- Malformed/legacy HTML, missing body boundary, unknown notation, invalid URLs,
  oversized images, duplicate IDs, and active markup.
- Copyright-active metadata must fail before content retrieval.
- Serialization is deterministic across two identical runs.

## Done criteria

- [ ] No raw upstream HTML reaches the serialized schema.
- [ ] XHTML-first and text-fallback paths pass fixture tests.
- [ ] Unknown constructs fail closed with actionable diagnostics.
- [ ] Output includes complete attribution and conversion provenance.
- [ ] Global checks pass.

## STOP conditions

- A fixture requires silently deleting meaningful source information.
- Copyright status is inferred from a person flag instead of the work flag.
- Converter correctness requires network access during unit tests.
- Output schema conflicts with the pagination decision from Plan 003.

## Maintenance notes

Every new upstream construct needs a fixture, schema decision, and versioning
review. Security reviewers should focus on URL normalization and HTML allowlists.
