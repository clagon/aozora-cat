# Aozora Cat

Aozora Cat is an unofficial, mobile-first web reader for copyright-expired
Aozora Bunko works. The reader is designed around quiet vertical writing,
offline access to opened works, local-only reading history, and no advertising
or account requirement.

## Development

```sh
pnpm install
pnpm dev
```

Quality gates:

```sh
pnpm check
pnpm lint
pnpm test:unit
pnpm test:e2e
pnpm build
```

The implementation is planned in [`plans/README.md`](plans/README.md). The
repository currently contains the Plan 001 foundation only; corpus ingestion,
reader behavior, and deployment are subsequent units.
