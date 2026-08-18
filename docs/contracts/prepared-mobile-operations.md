# Prepared mobile operations contract

Prepared mode is the mutation boundary for the private mobile transport. It exposes the existing read surface, but it replaces direct writes with a two-step request: preview one normalized change, then execute that recorded request against the exact Git base it was prepared from.

## Public tools

`prepare_vault_change` accepts one `operation` and one `arguments` object. The supported operations are:

- `create_note`: `path`, `content`, and optional `frontmatter`;
- `patch_note`: `path`, `oldString`, `newString`, and optional `replaceAll`;
- `update_frontmatter`: `path`, `frontmatter`, and optional `merge`;
- `manage_tags`: `path`, `operation`, and `tags`;
- `append_to_section`: `path`, `heading`, and `text`.

Unknown arguments fail closed. `create_note` refuses an existing target instead of inheriting `write_note` overwrite behavior. A proposal with no resulting content change also fails.

The successful response records:

- a UUID `requestId`;
- the fetched `baseHeadSha`;
- a SHA-256 `digest` over the actor, base commit, operation, and complete normalized arguments;
- the exact affected paths;
- an exact before-and-after content preview;
- creation and expiry timestamps;
- the `prepared` status.

Preparation refreshes from the canonical branch before capturing its base commit. It never changes the remote repository. Records expire after 15 minutes.
An exact preview larger than 1 MiB is refused instead of being truncated.

`execute_vault_change` accepts only `requestId`. It fetches and fast-forwards under the transaction lock, refuses execution when remote `main` no longer equals `baseHeadSha`, applies the recorded arguments, validates the result, commits, and pushes. Its visible receipt includes the final status, pushed commit SHA, and execution timestamps. The commit contains:

```text
Vault-Request-Id: <requestId>
Vault-Actor: <actor>
Vault-Operation-Digest: <digest>
```

The operation store uses owner-only permissions and atomic JSON replacement outside the vault. A completed replay returns the stored result only after its commit SHA and exact trailers match canonical Git history. If the service stops after a successful push but before recording success, the retry searches the canonical branch for an exact request-ID and digest trailer pair, records the recovered commit, and returns it without applying the mutation again.

`get_vault_operation` returns the same public receipt and preview fields without returning the recorded arguments. Execution, replay, and status lookup therefore expose the same final status and commit evidence. `vault_health` reports prepared-mode availability and Git synchronization state without exposing vault contents or local paths.

## Denied surface

Prepared mode never lists or executes `write_note`, `patch_note`, `update_frontmatter`, `manage_tags`, `append_to_section`, `delete_note`, `move_note`, or `move_file` directly. The prepared wrapper may invoke the non-destructive subset internally only from an immutable operation record.

MCP tool annotations are part of the transport contract. Reads and status tools carry `readOnlyHint: true`; execution carries `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`. Every tool carries `openWorldHint: true` because Git fetch and push cross the local process boundary.

## Pilot boundary

This contract covers one private actor, one dedicated vault clone, non-destructive direct-to-`main` changes, durable success replay, and stale-base refusal. It does not provide multi-principal authorization, destructive or structural changes, a PR lifecycle, or a durable append-only denial audit. Those remain outside the private pilot.
