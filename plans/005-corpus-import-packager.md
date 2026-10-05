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

Decisions made in this step (`packages/importer`):

- The CSV is read as RFC 4180; a stray quote (text after a closing quote, or a
  quote inside an unquoted field) stops the import instead of being repaired.
  Rows are grouped by work ID. A work's own columns must
  agree on every row; people are deduplicated by person ID and role and all
  roles are kept; rows for the same person and role must agree on name and
  reading or the work is rejected. Names and readings join surname and given name without a
  separator, as in the converter's `WorkSource`.
- The pinned schema is the set of columns the importer reads
  (`REQUIRED_COLUMNS`). A missing column, a repeated column (the authoritative value
  would be ambiguous), or a row whose column count differs from the header,
  stops the whole import (`CatalogFormatError`). A new unread
  column only adds a note, so a harmless upstream addition does not block the
  weekly run; reviewers see the note.
- A work whose value cannot be trusted is rejected with a reason instead of
  being guessed: an unknown copyright flag, an unknown role, a malformed ID or
  a date that is not on the calendar (such as 2025-02-31), a missing title or orthography, a card URL that does not match the
  work or whose person directory is not one of the work's people, or rows that disagree. Rejected works are never shipped.
- Only the work copyright flag decides distribution. Works flagged `あり` stay
  in the parsed catalog (the Step 4 diff needs them to report rights changes)
  but `selectBodies` never lists them, so no body request is made for them, and
  the search catalog leaves them out.
- A body URL is used only when it is an https `www.aozora.gr.jp/cards/<person>/files/`
  file of the same person directory whose leading number is this work's ID (the
  official names are `<id>.html`, `<id>_<n>.html` and `<id>_ruby_<n>.zip`; every
  real URL into the official files satisfies this), with `.html` for XHTML and `.zip` for
  text, a valid date, and a ShiftJIS or UTF-8 encoding. Anything else (such as
  an external site) is dropped with a note, and the other path is still used.
  Fetch order is XHTML first, then text.
- Downloads use a per-attempt timeout, a byte limit while streaming, retries
  with doubling delay for 429, 5xx, network errors and timeouts only, no
  redirects, and a `User-Agent` naming this project. The catalog zip is opened
  with one entry at most, a bound on the total expanded size checked before any
  entry is inflated, a CRC check, and a requirement of exactly one UTF-8 `.csv`.
- Measured against the official CSV of 2026-08-22 (checked locally; not
  committed): 17,840 works, 488 flagged `あり`, 17,352 flagged `なし`, of which
  7 have no usable body, leaving 17,345 fetch targets, all XHTML first. 198
  works have a body URL outside the official files and are noted. Nothing was
  rejected. Parsing takes about 0.3 s.
- Generated output goes under `.corpus/`, which is ignored by Git.

### Step 2: Fetch incrementally and reproducibly

Use bounded concurrency, conditional requests, immutable temporary staging, and
content hashes. Never overwrite the last known-good release during a failed run.
Record URL, upstream timestamps, hashes, converter version, and diagnostics.

**Verify**: a local fixture server proves retry, resume, unchanged reuse, and
failure rollback without reaching the public site.

Decisions made in this step (`packages/importer`, `run.ts`):

- Layout under `.corpus/` (ignored by Git): `raw/<sha256>` holds fetched
  bodies and is never rewritten; each run writes only to
  `runs/<runId>/{works,records}/<id>.json`; `manifest.json` is written only
  when every target has a record; `current.json` names the last known-good run
  and only `commitRun` changes it. Every file is written to a temporary name and
  renamed, so an interrupted run leaves no half-written file.
- A run fetches XHTML first and falls back to the text zip when the fetch,
  decoding, or conversion fails; each failed attempt is kept in the record
  (`attempts`). A work with no usable path is recorded as `failed` and the run
  continues. Records hold no clock values, so the same inputs give the same
  records, works, and manifest bytes.
- Reuse, in order: the key is a hash of every conversion input (the catalog
  fields passed to the converter, including the update date, plus the source
  URL and the declared encoding), so correcting a title, a person, or a card URL in the catalog always
  produces a new work. If that hash and the converter version equal the
  previous run's and the work file still matches its recorded hash, nothing is
  requested. Otherwise the body is requested with `If-None-Match` /
  `If-Modified-Since` from the previous record (only while the raw copy still
  exists); a 304 reuses the raw copy, and the work is converted again unless the
  body hash, the input hash, and the converter version all match the previous
  record. `revalidate` forces the conditional request for every work. The
  official site returns `ETag` and `Last-Modified` and answers 304 (checked live
  on 3 works).
- Resume: a run is bound to the inputs it started with (a hash of the converter
  version and every target's catalog fields, source URLs and encodings, kept in
  `run.json`) and to the `revalidate` setting; resuming with different inputs or a
  different setting is refused, and the run also keeps the `current` run it
  started from as its reuse base (a `run.json` whose base is missing or not an
  explicit `null` or valid run ID is refused, not read as "no base"), so a run committed in between cannot be
  mixed in, so old and new outputs never mix in one manifest. Running the same
  `runId` again with the same inputs skips works that already have a record
  whose id matches and whose work file still matches the recorded hash and size
  (otherwise the work is processed again), except fetch-level failures
  (network, timeout, status), which are tried again. Conversion failures are deterministic and are not retried. A
  corrupt record is treated as missing. A finished run (with a manifest) cannot
  be run again.
- A run directory has one writer at a time: `runImport` takes an exclusive lock
  (`runs/<runId>/lock`, created by hard-linking a file that already holds the
  owner's PID) and releases it when it ends or fails. A live owner is refused;
  a lock left by a dead process is renamed away and taken over.
- An unexpected failure in one worker (for example a filesystem error) stops the
  others from taking new works, and `runImport` waits for every worker to settle
  before it rejects, so nothing keeps requesting or writing after the caller
  sees the failure. When a previous result is reused, `attempts` always reflects
  the current invocation.
- The body size ceiling (64 MiB) can be lowered through `fetchOptions` but not
  raised. Every numeric setting is checked before any request: `maxBytes`,
  `timeoutMs`, `retries`, `retryDelayMs`, `concurrency` (1 to 64),
  `minIntervalMs`, and `commitRun`'s `maxFailureRatio` (0 to 1); `NaN` and
  out-of-range values are refused, because a comparison with `NaN` is always
  false and would silently disable a limit.
- Concurrency and politeness: a bounded worker pool (default 4) and a minimum
  interval between request starts (default 100 ms), applied to every HTTP
  attempt including retries. An abort signal stops
  starting new works and leaves the run resumable.
- Rollback: `commitRun` refuses a run that is unfinished, has an unreadable or
  inconsistent manifest, has a converted work whose file is missing or does not
  match its recorded hash and size, is empty, or whose failure ratio exceeds
  `maxFailureRatio` (default 2%), and leaves `current.json` untouched. Because a run never writes outside its own directory and `raw/`,
  a failed run cannot alter the last known-good release.
- `checkWork` validates every work before anything is read, written, or
  requested: a six-digit unique ID, a card URL for that work whose person directory is one of the work's people, and body URLs on
  the official host, in the same person directory, naming this work (the same
  rules as `parseCatalog`), so a hand-built `CatalogWork[]` cannot turn an ID
  into a path outside the run directory or send a request to another host. Run IDs must start with an alphanumeric character for the same
  reason.
- Copyright-active works are filtered again inside `runImport` (through
  `selectBodies`), so a caller cannot make it request their bodies.
- The work schema now accepts the official number-only file names
  (`733.html`, 116 works) as provenance; before, it required `<id>_<n>`, so
  those works could not be converted. This changes what the converter
  produces, so `CONVERTER_VERSION` is now 1.2.0.
- Known limits: failed works are requested again on the next run because no
  validators are kept for failures; image fetching and packaging are Step 3.

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
