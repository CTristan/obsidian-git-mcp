# 2. Refuse gitignored writes before mutating the live vault

Accepted 2026-07-25 to settle the design for [#11](https://github.com/CTristan/obsidian-git-mcp/issues/11). This narrows the transaction boundary established in [ADR 1](0001-wrap-mcpvault.md) to content git can actually commit and restore.

## Context

The server promises that an accepted tool write reaches the canonical remote, or the live vault stays unchanged. Git can uphold that promise for tracked and ordinary untracked paths: `git reset --hard` restores tracked content, and `git clean -fd` removes new untracked content after a failed transaction.

Gitignored content sits outside both commands. If a mutation changes a file that already existed under an ignore rule, `reset --hard` leaves its bytes alone and `clean -fd` deliberately skips it. `ignoredFingerprint()` detects that change after the mutation, but detection comes too late to restore the original bytes. The transaction returns an error while leaving part of the rejected write on disk.

The supported server paths already avoid that failure in two different ways. Delegated MCPVault writes run in a private staging clone, then check the complete manifest diff with `refuseIgnoredPaths()` before `applyCloneDiff()` touches the live vault. `append_to_section` resolves its destination and checks that concrete path before opening the live file.

The low-level `Transactor` does not enforce the same boundary. It accepts an arbitrary `transact()` callback, and the package exported both `Transactor` and `TransactorConfig` when we made this decision, so a caller could mutate an ignored file without running the preflight. Documenting that precondition would leave the main safety guarantee dependent on every current and future caller remembering it.

## Considered options

- **Snapshot every pre-existing ignored file before each mutation.** This would let rollback restore arbitrary ignored changes, but a normal vault can ignore large attachment, cache, workspace, or private-content trees. Copying all of that on every write adds cost proportional to content the transaction cannot commit.
- **Snapshot only the ignored files that changed.** A post-mutation manifest can identify changed paths, but it cannot recover their original bytes unless those bytes were copied first. The delegated staging clone sometimes has that source copy, while native writes do not, so this becomes two rollback models with different guarantees.
- **Stage every write.** Running native writes through the clone-and-diff path would expose their complete mutation set before live apply. It would also add clone, manifest, and cleanup overhead to simple native operations, and it reverses ADR 1's wrapper-native direction just as that boundary is meant to replace delegated writes.
- **Keep `Transactor` public with a documented precondition.** Requiring callers to invoke `refuseIgnoredPaths()` first preserves the current API, but the type and runtime still accept an unchecked mutation. A forgotten check would recreate the exact failure this decision is meant to remove.
- **Refuse gitignored destinations before live apply.** Gitignored content cannot become part of the pushed commit, so the transaction rejects the complete operation before any live byte changes. This keeps one honest boundary: if git cannot carry the write, the server does not perform it.

## Decision outcome

Gitignored paths are outside the supported writable surface. Every tool write must identify its complete mutation set after fetch and containment resolution, then pass every concrete affected path through `refuseIgnoredPaths()` immediately before live apply. If any path is ignored, the server rejects the whole operation with `HiddenIgnoredWriteError`; it never applies the non-ignored subset.

Delegated writes keep their private staging clone. They run the delegated tool, calculate the complete manifest diff, check every added, changed, and deleted path as one batch, then call `applyCloneDiff()` only after the batch passes.

Native writes declare every path they can affect before opening, deleting, moving, or replacing live content. A move checks its source and destination. A directory operation expands to its concrete affected descendants instead of assuming the directory's ignore result applies to every child. A symlinked destination checks the resolved in-vault path after containment validation, because the path the write reaches matters more than the spelling the caller supplied.

`ignoredFingerprint()` remains a diagnostic tripwire for an internal invariant breach. It is not a rollback mechanism, because its post-mutation signal cannot recreate original bytes. The pre-apply refusal is what keeps the transaction promise true.

`Transactor` and `TransactorConfig` are not part of the supported package exports. The server and CLI remain the supported write surface. `Identity` stays public because `VaultServerConfig` uses it, and the transaction error classes stay public so callers can classify server failures.

A same-UID process can still race filesystem or ignore state between preflight and apply. Preventing code with the same local authority from changing the checkout underneath the server requires an operating-system isolation boundary, not another path check. That attacker remains outside the threat model, consistent with the staging model accepted in ADR 1.

## Consequences

- Good, because the writable surface now matches git's real transaction boundary. Content git cannot commit never becomes part of an accepted live write.
- Good, because rollback never needs to copy, expose, or scan ignored content byte-for-byte. Large caches and private ignored trees do not add snapshot cost to every transaction.
- Good, because future wrapper-native tools must name their full mutation set before touching the vault. Multi-path operations fail atomically when any source, destination, or concrete descendant is ignored.
- Good, because delegated and native writes keep the isolation model that fits each operation while sharing one ignored-path rule at the live boundary.
- Bad, because tools cannot intentionally modify ignored content. That restriction is necessary because the canonical remote cannot record the result.
- Bad, because removing `Transactor` and `TransactorConfig` from the package exports is a source-level breaking change. The package is private, unpublished, and pre-MVP, so keeping an unsafe undocumented primitive costs more than preserving it.
- Bad, because preflight cannot defeat a same-UID process that changes the filesystem or ignore rules before apply. Operators who need that guarantee must isolate the server process and its checkout.
- Bad, because `ignoredFingerprint()` can only report an internal invariant breach after it happens. Tests must keep every supported live-write boundary behind preflight so that tripwire never becomes normal rollback behavior.
