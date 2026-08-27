# Plan 001: Bootstrap the verified SvelteKit foundation

> **Executor instructions**: Follow every step and verification gate. This is
> an empty, unborn repository; preserve `plans/`. Stop rather than choosing a
> materially different framework, package manager, deployment target, or test
> stack.
>
> **Drift check (run first)**: `git status --short -- . ':!plans'`
> Expected before work: no output. Any output is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: unborn `main` (no commit), 2026-08-27

## Why this matters

Every later unit assumes one reproducible SvelteKit/TypeScript foundation with
Cloudflare-compatible builds and one-command verification. Establishing it
first prevents feature plans from inventing incompatible tooling.

## Current state

- The repository contains only `.git/` and these `plans/` files.
- `main` has no commit. `origin` points to `clagon/aozora-cat`.
- No package manager, runtime version, source layout, or CI exists.

## Commands you will establish

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Check | `pnpm check` | no errors |
| Lint | `pnpm lint` | no errors |
| Unit | `pnpm test:unit` | all pass |
| E2E | `pnpm test:e2e` | all pass |
| Build | `pnpm build` | Cloudflare build exits 0 |

## Scope

**In scope**: root package/config files, `src/` foundation, `static/`,
`tests/`, `.github/workflows/ci.yml`, `.env.example`, `AGENTS.md`, `README.md`.

**Out of scope**: product screens, corpus ingestion, reader pagination,
Cloudflare resource creation, secrets, deployment, and generated works.

## Git workflow

- This is the first implementation unit; do not push or open a PR unless asked.
- Use Conventional Commits once the operator authorizes a commit.
- Never commit `.env`, Cloudflare credentials, or GitHub App keys.

## Steps

### Step 1: Scaffold without deleting plans

Create a minimal SvelteKit TypeScript app using `pnpm`, the current stable
SvelteKit release, and the Cloudflare adapter recommended by current official
docs. Add `.npmrc`/runtime metadata only when required for reproducibility.

**Verify**: `test -f package.json && test -f pnpm-lock.yaml && test -d plans`
must exit 0.

### Step 2: Establish project boundaries

Create `src/lib/{domain,server,ui}` and document that browser-only reading state
must not be imported by server or pipeline code. Add an empty landing route and
global layout with Japanese document language and mobile viewport support.

**Verify**: `pnpm check` exits 0.

### Step 3: Establish quality gates

Configure strict TypeScript, ESLint, Prettier, Vitest, Testing Library, and
Playwright with WebKit and Chromium projects. Add one meaningful smoke test at
each layer. Avoid snapshot-only tests.

**Verify**: `pnpm lint && pnpm test:unit && pnpm test:e2e` all exit 0.

### Step 4: Establish CI and contributor instructions

Add a public-repository GitHub Actions workflow running install, check, lint,
unit tests, E2E smoke tests, and build. Write `AGENTS.md` with exact commands,
scope boundaries, Japanese-copy conventions, and secret handling. Document
local setup and the agreed product constraints in `README.md`.

**Verify**: `pnpm build` exits 0 and workflow YAML parses with an available
local checker or `ruby -e 'require "yaml"; YAML.load_file(ARGV[0])' .github/workflows/ci.yml`.

## Test plan

- Unit smoke test proves the test environment renders a Svelte component.
- E2E smoke test opens `/`, verifies Japanese page metadata and no console error.
- Build test proves the selected adapter targets Cloudflare successfully.

## Done criteria

- [ ] All five global verification commands in `plans/README.md` pass.
- [ ] Lockfile and runtime requirements are committed-ready.
- [ ] CI uses only free public-repository capabilities and contains no secrets.
- [ ] `AGENTS.md`, `README.md`, and `.env.example` explain the baseline.
- [ ] No product feature beyond a smoke landing page was implemented.

## STOP conditions

- Non-plan source files appear before work begins.
- The current SvelteKit Cloudflare adapter cannot produce a supported build.
- Any proposed dependency requires a paid service for local verification.
- Verification requires weakening strict TypeScript or lint rules.

## Maintenance notes

Plan 001 owns shared scripts. Later plans may add focused commands but must not
rename or remove the five global gates without updating every dependent plan.
