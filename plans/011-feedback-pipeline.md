# Plan 011: Build the privacy-preserving feedback pipeline

> **Executor instructions**: Use a dedicated GitHub App with Issues-only access
> to one private repository. Never print, persist, or return secrets. Do not
> create real external resources or GitHub issues without operator approval.
>
> **Drift check (run first)**: `git status --short -- src/routes/api/feedback src/lib/server/feedback src/routes/other/feedback migrations wrangler*`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001, 006, and 010
- **Category**: security
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Non-developer users need an in-app report form without a GitHub account. The
pipeline handles optional email and privileged GitHub credentials, so validation,
anti-abuse, minimization, retry safety, and retention must be designed together.

## Current state

Required fields: category and description; optional reply email. Work ID, URL,
browser, OS, viewport, and app version are previewed before submission. Reading
history, position, favorites, other works, text bodies, and search terms are not sent.

## Scope

**In scope**: feedback page/form, Worker endpoint, validation, Turnstile,
rate limiting, D1 queue/migrations, GitHub App client, retry job, retention/redaction,
safe error telemetry endpoint, tests, `.env.example` variable names.

**Out of scope**: screenshots/uploads, public issue creation, email delivery,
real secret values, account creation, and an admin dashboard.

## Steps

### Step 1: Define the request and queue model

Use runtime schema validation, bounded Unicode lengths, category enum, optional
email validation, generated receipt ID, timestamps, retry state, and minimal
technical context. Store no raw IP; if rate limiting needs a key, use a rotating
keyed hash with short retention.

**Verify**: schema tests reject excess, unknown fields, invalid email, forged
technical fields, and private-data fields.

### Step 2: Implement form and Turnstile verification

Show the exact payload and retention notice before submit. Validate Turnstile
server-side, enforce same-origin and content-type constraints, rate limit, and
write an idempotent D1 queue record before acknowledging with receipt ID.

**Verify**: integration tests cover valid, expired/replayed token, abuse limit,
duplicate submit, quota error, and retained form content on failure.

### Step 3: Deliver through a least-privilege GitHub App

Mint short-lived installation tokens server-side and create issues only in the
configured private repository. Use stable labels and a redacted template. Mark
delivery atomically and retry with bounded backoff; never duplicate an issue.

**Verify**: mocked GitHub API tests cover auth refresh, rate limit, retry,
idempotency, invalid installation, and response redaction.

### Step 4: Enforce retention

After an issue closes, remove optional contact data after 30 days while retaining
technical report content. Purge expired rate-limit material and delivered queue
records according to documented schedules.

**Verify**: fake-time tests prove contact deletion and no premature removal.

## Test plan

- Unit validation and redaction tests.
- Worker/D1 integration against local bindings.
- Contract tests against a fake Turnstile and GitHub endpoint.
- E2E form preview, submit, receipt, retry, opt-out, and keyboard flow.
- Security header/CORS/log inspection tests.

## Done criteria

- [ ] No secret or optional email appears in logs/client errors.
- [ ] Every accepted report has a receipt and durable queue record.
- [ ] GitHub delivery is idempotent and private-repo-only.
- [ ] Contact data is redacted 30 days after resolution.
- [ ] Free-quota failures stop safely without billing fallback.
- [ ] Global checks pass.

## STOP conditions

- The GitHub App has broader than required repository/Issues permissions.
- A real private repository or Cloudflare resource must be mutated without approval.
- Turnstile cannot be validated server-side in the selected runtime.
- Required security work exceeds Workers Free CPU/request limits.

## Maintenance notes

Rotate App credentials according to an operator procedure. Review abuse limits,
retention jobs, and GitHub API changes before each major release.
