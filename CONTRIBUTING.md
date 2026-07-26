# Contributing

## Setup

You need Node ≥ 24, pnpm, and git ≥ 2.32 on `PATH`. The transaction wrapper shells out to the system `git`, and the test fixtures isolate themselves from your host git config through `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, which older git silently ignores — a leak that would let a global hook, alias, or signing setting change test behavior.

pnpm doesn't ship with Node, so enable it via Corepack first — the README's [Installing](README.md#installing) section has the bootstrap, including the `corepack@latest` caveat, and pointing there instead of repeating it keeps the two copies from drifting.

```sh
pnpm install
```

## Build and test

```sh
pnpm check:docstrings  # requires 80% JSDoc coverage across src
pnpm test              # full contract suite
pnpm typecheck         # tsc --noEmit over src + test
pnpm build             # emits dist/ (the stdio bin lives at dist/cli.js)
```

The contract tests in `test/contract/` are the specification — we write the failing test first, then implement until it passes. If you change behavior, change the contract test in the same commit.

`pnpm check:docstrings` counts implementation-bearing functions, constructors, accessors, named methods, and module-level callable variables. It ignores type-only declarations, anonymous callbacks, nested callable variables, declaration files, and tests. The complete `src` tree must stay at or above 80%, because [ADR 4](docs/decisions/0004-enforce-source-docstring-coverage.md) makes the repository-owned result the required and reproducible coverage boundary.

## Test fixtures

Every test builds throwaway repos under a temp directory: a bare "remote", the server's checkout, and a separate collaborator clone for simulating concurrent editors. Fixtures set their own `user.name`/`user.email` and disable `commit.gpgsign` locally, because a run must never depend on (or prompt against) your global git config. Nothing ever touches a real vault.

## Conventions

- Git commands run through `execFile` with argument arrays — never interpolate anything into a shell string.
- Dependencies are exact-pinned; Renovate proposes updates.
- The transaction wrapper never force-pushes and never resolves a semantic conflict on its own. Keep it that way.
