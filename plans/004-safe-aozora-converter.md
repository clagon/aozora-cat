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

Decisions made in this step:

- A block id is `p-` plus 12 hex characters of a SHA-256 over the block kind and
  its position text (ruby readings and notes excluded, images counted as one
  character). Identical blocks get an occurrence suffix (`-2`); an empty line
  also mixes in the previous block so blank lines do not collide. Inserting or
  deleting other blocks therefore never changes an id. `CONVERTER_VERSION` is
  1.1.0 because the id scheme changed, and 1.2.0 because the schema began to
  accept number-only official file names (`733.html`) in provenance, which
  turned a conversion failure into a success; `schemaVersion` stays 1.
- A saved position is `{ blockId, offset, before, after, percent }`: up to 24
  characters of context on each side, within the block, and the share of the
  whole work. Offsets count UTF-16 units, like the Plan 003 prototype.
- `restorePosition` tries, in order: the same block with matching context
  (`exact`), the context found at exactly one place in the new work
  (`context`; ambiguous matches are never guessed), then the percentage
  (`percent`, the reader should tell the user that the position may have moved).
  When the same text and kind (the same id apart from its occurrence suffix)
  appears in several blocks, ids can be renumbered by an
  insertion, so the twin nearest to the saved percentage is chosen and the
  result is `context`, never `exact` (the comparison includes the offset). The
  percentage is rounded to the nearest boundary, and 1 maps to the end of the
  last block. A corrupted saved value (missing or
  wrongly typed fields) falls through to the percentage instead of throwing.
- `serializeWork` validates and writes canonical JSON; `readWork` returns a typed
  failure for broken JSON, unsupported versions, or invalid works. There is
  only one schema version, so there is no migration between work versions yet.
- Known limit: an edit inside the 24 characters of context around the saved
  offset falls back to the percentage.

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

## Deferred constructs

Schema version 1 covers the notation used by the approved fixtures and the
fields of the official catalog. The converter must fail closed on the
constructs below until a fixture requires them and a schema decision is made:

- Block-scoped begin/end forms (`［＃ここから罫囲み］`, block-level 横組み and
  character-size ranges), which need a wrapper or range marker over blocks.
- Window headings and inline headings (同行見出し・窓見出し), which change how
  the surrounding text flows and need a heading form independent of its level.
- Character-width ranges (`jizume_N`), block-form captions (`div.caption`),
  italic (`span.shatai`), and ruby readings that contain images. Checked
  against the official XHTML: only 黒死館殺人事件 (No. 1317) among the approved
  works uses a deferred construct (`div.yokogumi`), so its full text fails to
  convert until that is decided; the other six convert in full.
- Any other construct from the official annotation guide not listed in the
  approved fixtures (for example 返り点 and 訓点送り仮名).
- Per-work image ownership beyond the person directory. The schema only
  bounds image URLs to the work's own `files` directory and the shared gaiji
  directory. The converter derives image URLs solely from references in the
  source file, resolved against its URL, and the importer (Plan 005) checks
  them against what it actually fetched.
- Text path only: ruby whose base would have to be guessed (an implicit base
  that is a symbol such as `＋《…》`, an accent bracket `〔…〕《…》`, or an image
  note; an explicit `｜` base of plain text is fine, an image base is not), accent
  decomposition ranges (a `〔…〕` that contains ASCII letters, such as
  `〔e'tiquette〕`), `［＃大きな文字］` and `［＃小さな文字］`
  ranges, and the block forms of 横組み and 罫囲み. For the approved works the
  text path yields blocks identical to the XHTML path for the same six works
  (checked locally against the official files); 黒死館殺人事件 fails on the
  same deferred block forms plus a symbol ruby base.
