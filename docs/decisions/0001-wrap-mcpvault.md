# 1. Wrap MCPVault in-process instead of forking a git-flavored vault server

Accepted 2026-07-21 as the phase-1 spike's verdict. Recorded as a decision doc 2026-07-23; the candidate survey comes from my pre-spike design notes. Re-evaluated 2026-07-23 against two days of hardening evidence: the decision stands, and the [re-evaluation](#re-evaluation-2026-07-23) commits to a phased end-state.

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

## Re-evaluation (2026-07-23)

Two days of adversarial review hardened the wrapper and produced evidence the spike could not have had, so we re-ran the decision against it: a coupling audit of the wrapper, an upstream health check, and two opposing briefs arguing swap and keep. The decision stands. The end-state direction changed.

### Options the spike record never captured

- **Fork MCPVault itself** — patch out the quirks and the parser exposure instead of guarding around them. Rejected for the same reason forking the git-flavored servers lost: a fork forfeits upstream's fixes precisely where upstream is strongest (path-security CVEs have shipped promptly), while keeping every maintenance cost.
- **Remote-first, no checkout** — write through GitHub's git-data API (create blobs and a tree, commit, then a compare-and-swap ref update). The atomic ref update is genuinely cleaner than fetch, fast-forward, push, and retry, but every read, search, and validation still wants a local checkout, and it hard-couples the server to GitHub when the design only requires a git remote. Rejected.
- **Wiring variant: in-process versus subprocess.** The spike enumerated wiring options (a stray "Option (a) protocol proxy" comment survived into review), but the losing side never made it into the record. In-process over `InMemoryTransport` won; the obvious alternative, a spawned subprocess over stdio, would have added a process to supervise and a serialization boundary inside every transaction. Just to clarify, that reasoning is reconstructed after the fact — the outcome is original, the rationale for the loser is not.

### What the hardening evidence says

- Of the 15 proxied tools, only `search_notes` and `list_all_tags` carry an algorithm worth keeping (ranking and snippets; vault-wide tag extraction). The other 13 are direct filesystem or gray-matter primitives, and gray-matter is already a direct dependency of the wrapper.
- The wrapper's most complex subsystems exist to defend against MCPVault specifics, not to add value: the clone-per-write sandbox (MCPVault writes straight to the path it is constructed with, so every delegated write runs against a throwaway clone and diffs back), the vault-wide executable-frontmatter scan (MCPVault leaves gray-matter's `js`/`javascript` engines live, so every fetched note is screened before MCPVault may parse it), and five mirrored internals, all but one drift-tested (the exception is the per-tool path-argument names).
- `append_to_section` already proves the alternative: a wrapper-native write that keeps the fd-pinned writes, symlink containment, transaction, and rollback while needing none of that scaffolding.
- Upstream is real but concentrated: ~29k npm downloads a month and a track record of shipping path-security CVE fixes promptly, against a single maintainer holding ~81% of commits, bursty releases, and the frontmatter code-execution exposure still open and untracked upstream (its security docs claim frontmatter validation, but the `---js` engine path is not covered by it).

### Verdict

Wrapping was the right call on 2026-07-21 and we would make it again, because it bought a working, contract-passing surface in a day and let the transaction layer be built against something real. But the better end-state, on today's evidence, is a phased handover, because the write side of the black box now costs more than it delivers:

- **Own the write and destructive tools** (`write_note`, `patch_note`, `update_frontmatter`, `manage_tags`, and the gated delete/move set). They are filesystem and gray-matter primitives; owning them deletes the clone-per-write sandbox, removes the frontmatter whitespace quirk (byte-targeted updates become possible), and puts `patch_note`'s replacement semantics at a call site we control.
- **Keep MCPVault black-boxed for the read side**, `search_notes` and `list_all_tags` in particular, because the contract suite asserts only shallow outcomes there and a naive reimplementation would pass green while degrading search quality. The read-side frontmatter scan stays for as long as MCPVault parses notes.
- The handover is future roadmap work, not part of this phase. Note-semantics features were heading into the wrapper regardless (`get_backlinks` and `resolve_wikilink` in [#2](https://github.com/CTristan/obsidian-git-mcp/issues/2)), so the boundary was already migrating.

Either way the git transaction layer, which is the point of the project, is untouched. The choice only moves the tool surface.

### Swap triggers

Any of these accelerates or completes the handover:

- An upgrade renames a path-carrying tool argument or adds a tool the classification pin doesn't know (the contract suite's known-tool pin goes red). This is the one unguarded mirror firing.
- Upstream changes its frontmatter-engine handling in either direction, because a regression widens the exposure and a fix strands a vault-wide guard we can neither prove unnecessary nor delete while black-boxing.
- A path-security regression lands in a release (the containment suite goes red on a version bump).
- Any release injects non-content payloads into tool responses (an unsolicited ad-SDK pitch is sitting open upstream as this is written). That one is immediate: pin, freeze, and swap.
- Upstream goes quiet: roughly six months without a release while a security-relevant issue sits open, or the package is archived or unpublished.
- Read-side parity lands anyway (search ranking and tag extraction reach quality we accept), at which point the last reason to keep the dependency is gone.
