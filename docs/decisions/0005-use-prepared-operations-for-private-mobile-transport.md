# 5. Use prepared operations for the private mobile transport

Proposed 2026-08-18.

## Context

The local Game Recommendations integration proved one useful transport pattern: a personal Codex plugin can launch a local MCP server over stdio, while OpenAI Secure MCP Tunnel exposes a separate process to a private ChatGPT app that works on mobile. `obsidian-git-mcp` already supplies the transactional Git boundary, but exposing its full write surface through that transport would let a remote client invoke overwrite-capable and destructive tools without a separate preview boundary.

The first pilot runs on one private Mac. GitHub `main` remains canonical, and service processes use dedicated clones instead of the live iCloud Obsidian vault.

## Considered options

- **Expose the existing MCP surface through the tunnel.** This has the least implementation work and preserves identical local and remote behavior. It also exposes direct `write_note`, delete, and move semantics, and retries remain coupled to individual tool behavior instead of one public replay contract.
- **Add a prepared-operation mode inside `obsidian-git-mcp`.** This reuses the existing validation and Git transaction layer while putting preview, base binding, expiry, and replay recovery at one enforced boundary. It adds an operation ledger and a second public tool profile.
- **Build a separate mobile gateway.** A gateway can own authorization, audit, and policy without changing the vault server. It duplicates schemas and request normalization, creates another security boundary, and makes exact preview parity harder to prove.
- **Keep the GitHub connector as the only mobile path.** This avoids a new daemon and tunnel. It does not provide the vault-aware operation surface or deterministic app identity this pilot exists to test.

## Decision outcome

Use prepared-operation mode inside `obsidian-git-mcp` for the private Mac pilot. Codex and the Secure MCP Tunnel each launch the same prepared-mode server against separate dedicated vault clones and operation ledgers. The tunnel remains transport only; it does not define vault policy or mutation semantics.

Prepared mode exposes reads plus `prepare_vault_change`, `execute_vault_change`, `get_vault_operation`, and `vault_health`. It hides and rejects direct writes and every destructive tool. The allowed operation set is `create_note`, `patch_note`, `update_frontmatter`, `manage_tags`, and `append_to_section`. `create_note` refuses existing paths.

Preparation records the fetched base commit, normalized complete arguments, exact preview, affected paths, actor-bound digest, and a 15-minute expiry in an owner-only ledger outside the vault. Execution requires the recorded base to remain current. A successful commit carries the request ID, actor, and digest as trailers. A replay first trusts a completed durable record; an interrupted record is recovered only from an exact request-ID and digest match on the canonical branch.

The detailed interface belongs in [the prepared mobile operations contract](../contracts/prepared-mobile-operations.md). Deployment and acceptance belong in [the private mobile pilot runbook](../runbooks/private-mobile-pilot.md).

## Consequences

- Good, because local Codex and mobile ChatGPT exercise one mutation contract and one Git transaction implementation.
- Good, because remote clients cannot discover or bypass the preview boundary to call direct or destructive writes.
- Good, because a stale proposal stops after fetch instead of being silently rebased onto a different vault state.
- Good, because Git trailers recover the important lost-acknowledgment case even when local operation state still says `running`.
- Bad, because every client-visible mutation takes two calls and expires after 15 minutes.
- Bad, because exact previews include complete changed note content, which the private transport must protect as vault data.
- Bad, because large notes can exceed transport budgets; the pilot refuses exact previews above 1 MiB instead of returning a misleading truncation.
- Bad, because the local ledger is required for prepared requests that have not yet committed; Git can reconstruct successful replays, but not abandoned previews.
- Neutral, because GitHub `main` remains canonical and the existing GitHub connector remains an outage fallback during the pilot.
- Neutral, because multi-principal authorization, destructive PR routing, and append-only denial auditing remain future production work rather than being implied by a private single-actor pilot.

## Revisit triggers

Revisit this decision before adding another principal, exposing the service beyond the private app, enabling destructive or multi-file operations, moving the service off the private Mac, or removing the GitHub compatibility path. Any of those changes expands the authorization or recovery boundary enough to require a new decision.

## Adversarial review

The strongest simpler alternative is the existing direct tool surface, because the Git transaction layer already validates and pushes each write safely. It still loses here because the remote client would retain overwrite-capable and destructive entry points, and no common public contract would bind preview, expiry, and replay recovery.

The review found four enforcement gaps and changed the proposal:

- Concurrent retries in one process could both observe `prepared`, so execution now coalesces calls by `requestId` before they reach the transaction queue.
- A same-uid local process could edit the ledger, so execution recalculates the actor-bound digest and regenerates the internal tool call from the digested public arguments instead of trusting stored internal fields.
- An exact preview can disclose the entire changed note and exhaust client budgets, so the transport stays private and refuses previews above 1 MiB.
- The tunnel runtime key authenticates the private transport, but it does not provide multi-principal vault authorization. The pilot therefore remains one actor, and broader exposure is a revisit trigger rather than an implied capability.

The change is reversible: switch clients back to `direct`, unload the tunnel, and remove the personal plugin without changing vault history. Successful prepared commits remain ordinary attributed Git commits; abandoned preview records can be archived or removed after their expiry.
