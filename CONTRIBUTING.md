# Contributing

## Setup

You need Node ≥ 24, pnpm, and git on `PATH` (the transaction wrapper shells out to the system `git`).

```sh
pnpm install
```

## Build and test

```sh
pnpm test        # full contract suite
pnpm typecheck   # tsc --noEmit over src + test
pnpm build       # emits dist/ (the stdio bin lives at dist/cli.js)
```

The contract tests in `test/contract/` are the specification — we write the failing test first, then implement until it passes. If you change behavior, change the contract test in the same commit.

## Test fixtures

Every test builds throwaway repos under a temp directory: a bare "remote", the server's checkout, and a separate collaborator clone for simulating concurrent editors. Fixtures set their own `user.name`/`user.email` and disable `commit.gpgsign` locally, because a run must never depend on (or prompt against) your global git config. Nothing ever touches a real vault.

## Conventions

- Git commands run through `execFile` with argument arrays — never interpolate anything into a shell string.
- Dependencies are exact-pinned; Renovate proposes updates.
- The transaction wrapper never force-pushes and never resolves a semantic conflict on its own. Keep it that way.
