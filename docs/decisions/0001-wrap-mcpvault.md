# 1. Wrap MCPVault in-process instead of forking a git-flavored vault server

Accepted 2026-07-21 as the phase-1 spike's verdict. Recorded as a decision doc 2026-07-23; the candidate survey comes from my pre-spike design notes.

## Context

My vault's `main` branch on GitHub is the canonical copy of my second brain, and multiple AI collaborators plus my own devices read and write against it. That sets the bar for the tool surface: every write must land as a validated, attributed, pushed commit or not happen at all, because a silently lost concurrent edit is unrecoverable in a second brain.

Phase 1 was a TDD spike built to answer the build-vs-wrap question. We wrote the contract suite first (34 protocol-level tests at the time, spanning reads with HEAD-SHA stamping, attributed writes, targeted patches, validation rollback, conflict safety, path security, locking, destructive-tool gating, and crash recovery), then evaluated candidates against it. Whatever passed underneath the suite would become the tool surface. The git transaction layer was always going to be ours, because making git the transaction boundary is the whole point of the project.

## Considered options

- **Wrap MCPVault** (`bitbonsai/mcpvault`) — a headless Node MCP server that works directly against a vault directory. It already provides note CRUD, targeted patching, frontmatter handling, search, tags, and path filtering, but it has no git awareness at all.
- **Fork an existing git-flavored vault MCP server** — start from a server that already speaks git and bend its sync model into per-write transactions.
- **Obsidian Local REST API** (`coddingtonbear/obsidian-local-rest-api`) — vault-native operations from inside Obsidian itself, including targeted heading/frontmatter patches and command execution.
- **Thin custom MCP service** — build a constrained tool surface around the git checkout from scratch.

## Decision outcome

Wrap MCPVault in-process as a black-box protocol proxy over an `InMemoryTransport` pair. The wrapper owns everything git: transactions, attribution, locking, and startup crash recovery. MCPVault passed the full contract suite underneath the wrapper on 2026-07-21, which settled the question: the leading candidate held up, so build-vs-wrap resolved to wrap.

The fork candidates lost on their git models. The existing git-flavored servers either treat the local checkout as a disposable cache the remote overwrites, or batch writes on a debounce timer and push whenever, and both models are the opposite of per-write transactions. Forking one means rewriting its core sync model while inheriting everything else, which is a rewrite wearing a fork's name. (Just to clarify, the spike record judged the category by those git models and never named the candidates individually, so this record preserves the judgment as it was made.)

The Local REST API lost on its runtime requirement. It runs inside Obsidian, so the server would need the desktop application running continuously, and nothing in the requirements needs live Obsidian metadata caches or active-file awareness badly enough to justify that.

The thin custom service was the fallback in case nothing could pass the contract. MCPVault passed, so building note CRUD, patching, frontmatter handling, and search from scratch buys nothing but maintenance. (My design notes put it well: reuse an existing Markdown/frontmatter parser rather than ad hoc regular expressions, humanity having suffered enough from those already.)

## Consequences

- Good, because git logic lives in exactly one place. The wrapper is the transaction boundary, and MCPVault never touches git, so there is no second sync model to fight.
- Good, because the contract suite, not MCPVault, is the specification. Nothing reaches into MCPVault's internals, so if it ever fails the contract we can swap the tool surface without touching the git layer.
- Good, because the tool surface arrives as an exact-pinned dependency, so upstream fixes flow in through Renovate instead of a fork we would have to rebase forever.
- Bad, because black-boxing means defending against MCPVault's behavior instead of changing it. Its bundled frontmatter parser executes `---js` blocks in-process, so the wrapper carries an RCE guard matched to MCPVault's parsed-extension set.
- Bad, because the wrapper mirrors a few MCPVault internals (path canonicalization, tool schemas, the note-extension set), and every mirror needs a drift test that goes red when an upgrade changes the original.
- Bad, because two tool behaviors are inherited as-is: `update_frontmatter` normalizes flow-style whitespace, and `patch_note` is exact-string replace. Both are documented in the [README's behavior notes](../../README.md#behavior-notes), because you will hit them when writing, and neither was disqualifying.
