# 4. Enforce source docstring coverage in repository CI

Accepted 2026-07-26 after `resolve_wikilink` exposed a gap between CodeRabbit's pre-merge
warning and the repository's required CI checks. The checker passed its declaration and
failure-mode tests, reproduced the corrected 36/109 baseline, and passed the migrated tree at
88/109.

## Context

CodeRabbit reported 8% docstring coverage for the wikilink pull request, against its default
80% threshold. That warning did not affect the repository's required `CI` status, and a
contributor could not reproduce it locally because CodeRabbit does not publish the complete
declaration-counting formula behind the percentage.

The source tree already uses JSDoc to record transaction guarantees, filesystem safety
boundaries, and non-obvious parsing behavior. Coverage is inconsistent, though. The first
repository-owned scan found 36 documented implementation declarations out of 109 (33.03%).
That count differs from the initial 35/109 estimate because the JSDoc attached to the first
`stringArg` overload correctly documents the overload's implementation as one declaration.

We need one definition that runs before a pull request, remains part of the required CI status,
and behaves the same on Linux, macOS, and Windows. The check must reward useful documentation
without requiring comments on anonymous callbacks, type-only declarations, or every local
closure.

## Considered options

- **Keep CodeRabbit as the only coverage check.** This preserves the existing warning, but it
  leaves the result outside required CI and gives contributors no local command to run.
- **Use TypeDoc's documentation validation.** TypeDoc has strong export-oriented documentation
  support, but its validation reports undocumented reflections rather than an aggregate
  whole-tree percentage. It also makes exported API documentation the center of the policy,
  while this repository needs internal transaction and parser invariants documented too.
- **Add ESLint, TypeScript-ESLint, and `eslint-plugin-jsdoc`.** These tools can require JSDoc on
  selected declaration contexts, but the repository has no lint stack today. Adding that stack
  for one percentage gate brings several packages and still needs custom aggregation logic.
- **Scan source text with regular expressions.** This keeps the script small, but regular
  expressions cannot reliably group overloads or distinguish methods, callbacks, declarations,
  and callable variables across valid TypeScript syntax.
- **Scan the TypeScript AST with the pinned compiler.** This reuses the parser that already
  validates the project and lets the repository define the denominator directly. The API is
  explicitly unstable, so compiler upgrades can break the checker.

We also considered narrower or stricter policies:

- Changed-code-only coverage would match CodeRabbit's pull-request focus, but the existing
  documentation debt would remain indefinitely.
- Public-API-only coverage would keep the denominator small, but it would omit the internal
  security and transaction functions whose contracts matter most during maintenance.
- A 90% or 100% whole-tree threshold would leave less room for missing documentation, but it
  would also push comments onto self-explanatory adapters and predicates. An 80% threshold
  matches the warning that prompted this decision and leaves review responsible for deciding
  where the remaining comments add value.

## Adversarial review

An aggregate threshold can be gamed with empty or repetitive comments, and it can admit a new
undocumented declaration while the repository has enough headroom. The checker deliberately
measures presence, not prose quality, because a static rule cannot prove a comment is accurate.
Review still owns that judgment. The migration uses comments that state contracts, invariants,
side effects, or reasons, and the checker provides no per-symbol suppression marker that could
silently remove a declaration from the denominator.

Depending on `typescript/unstable/sync` and `typescript/unstable/ast` creates an upgrade risk.
The alternative is another parser dependency that can drift from the compiler accepting the
project. Exact-pinning TypeScript, exercising every counted node category in tests, running the
checker on three operating systems, and failing closed when the API or parser fails makes that
risk visible during an upgrade.

The declaration boundary needs to resist accidental denominator changes. The checker counts
implementation-bearing function declarations, constructors, accessors, named class or object
methods, and module-level named arrow functions or function expressions. It excludes declaration
files, interfaces, type aliases, anonymous callbacks, nested callable variables, and tests.
Overload signatures count with their implementation as one declaration, and JSDoc on any
immediately preceding same-name overload documents that group. Applying that rule corrected the
initial baseline from 35/109 to 36/109 before the migration began.

Rounded output can also hide a failing ratio near the boundary. The checker compares integer
counts against the decimal threshold before formatting the percentage, treats an empty source
tree as 100%, and exits with an operational error instead of a coverage result when TypeScript
cannot parse a source file.

## Decision outcome

Add `pnpm check:docstrings` as a repository-owned whole-tree check with an 80% threshold. The
script enumerates eligible files under `src`, opens them through the pinned TypeScript compiler
even when `tsconfig.json` excludes them, scans their declarations, prints each missing docstring
as `file:line`, and exits nonzero below the threshold.

Run the command in the existing Linux, macOS, and Windows test matrix so the aggregate `CI`
status covers it on every pull request and `main` push. CodeRabbit may continue reporting its own
percentage, but the repository-owned result is authoritative because its counting rules are
local, deterministic, and tested.

Migrate the current source tree to at least 80% before enabling the CI step. Future changes may
alter which declarations remain undocumented, but the complete tree must stay above the same
floor. We will not add per-symbol exclusions.

## Consequences

- Good, because contributors can run the same required check locally before opening a pull
  request.
- Good, because internal security, parsing, and transaction contracts count alongside exported
  functions.
- Good, because one whole-tree threshold prevents the existing documentation debt from hiding
  outside a pull request's changed lines.
- Good, because the checker adds no parser or lint dependency beyond the exact-pinned compiler
  already used by the build.
- Bad, because 80% coverage does not prove the comments are correct or useful. Review must reject
  comments that only restate a signature.
- Bad, because aggregate headroom can temporarily admit an undocumented declaration. A later
  change will fail once the complete ratio drops below 80%.
- Bad, because a TypeScript upgrade may change or remove the unstable AST API. The checker will
  fail until its adapter and classification tests are updated for that compiler.
- Bad, because the whole-tree gate makes unrelated pull requests responsible for any coverage
  regression already merged to `main`. That is intentional because the required branch should
  never remain below its documented floor.
