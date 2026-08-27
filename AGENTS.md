# Aozora Cat contributor guide

## Product boundary

Aozora Cat is an unofficial, mobile-first Japanese reader for copyright-expired
works from Aozora Bunko. It has no account, advertisements, server-side reading
history, social features, AI features, or paid services. Keep source attribution
and the quiet reading experience intact.

## Commands

Use pnpm for dependency installation and project checks:

- `pnpm install` to install dependencies
- `pnpm check` for Svelte and TypeScript checks
- `pnpm lint` for Prettier and ESLint checks
- `pnpm test:unit` for unit tests
- `pnpm test:e2e` for Chromium and WebKit browser tests
- `pnpm build` for the Cloudflare production build

## Conventions

- TypeScript is strict. Avoid `any`, unsafe casts, and raw upstream HTML sinks.
- Keep browser storage, corpus conversion, and server code behind typed modules.
- Use concise natural Japanese for UI copy and comments.
- Never commit `.env` files, Cloudflare credentials, GitHub App keys, generated
  corpus data, or user reading data.
- Do not change plans or add product features without updating the relevant plan.
