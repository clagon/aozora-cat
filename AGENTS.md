# Aozora Cat contributor guide

## Product boundary

Aozora Cat is an unofficial, mobile-first Japanese reader for copyright-expired
works from Aozora Bunko. It has no account, advertisements, server-side reading
history, social features, AI features, or paid services. Keep source attribution
and the quiet reading experience intact.

## Commands

This environment uses npm because pnpm is not installed. Run:

- `npm install` to install dependencies
- `npm run check` for Svelte and TypeScript checks
- `npm run lint` for Prettier and ESLint checks
- `npm run test:unit` for unit tests
- `npm run test:e2e` for Chromium and WebKit browser tests
- `npm run build` for the Cloudflare production build

## Conventions

- TypeScript is strict. Avoid `any`, unsafe casts, and raw upstream HTML sinks.
- Keep browser storage, corpus conversion, and server code behind typed modules.
- Use concise natural Japanese for UI copy and comments.
- Never commit `.env` files, Cloudflare credentials, GitHub App keys, generated
  corpus data, or user reading data.
- Do not change plans or add product features without updating the relevant plan.
