# Private mobile pilot runbook

This pilot reuses the proven Game Recommendations topology: Codex starts the same service over local stdio, while ChatGPT mobile reaches a separate prepared-mode process through OpenAI Secure MCP Tunnel. Both processes use dedicated service clones and converge through GitHub `main`. Neither process points at the live iCloud Obsidian vault.

## Fixed layout

Choose explicit private paths for:

- the built `obsidian-git-mcp` checkout;
- a Codex-only clone of the vault;
- a tunnel-only clone of the vault;
- a separate operation-state directory beside each clone;
- the Secure MCP Tunnel configuration and runtime key.

Create both operation-state directories before starting their launchers, and set each to mode `0700`.

The two service clones may share the canonical remote, but they may not share a worktree or operation-state directory. Keep the runtime key outside every repository and vault.

## Local Codex path

Build the server, clone the vault, and set the launcher environment:

```sh
pnpm install --frozen-lockfile
pnpm build
git clone <private-vault-remote> <codex-vault-clone>
OGM_COLLABORATOR="Codex" \
OGM_ACCESS_MODE=prepared \
OGM_OPERATION_STATE_DIR=<codex-operation-state> \
node <obsidian-git-mcp>/dist/cli.js <codex-vault-clone>
```

The personal `obsidian-vault` plugin wraps this stdio launch. Its launcher defaults to `~/.local/share/obsidian-git-mcp/server`, `~/.local/share/obsidian-git-mcp/codex/vault`, and `~/.local/share/obsidian-git-mcp/codex/operations`. `OBSIDIAN_GIT_MCP_ROOT`, `OBSIDIAN_GIT_MCP_VAULT`, and `OBSIDIAN_GIT_MCP_STATE` override those paths without putting a repository credential or vault content in the plugin.

## Mobile tunnel path

Create a second vault clone and start the server with `OGM_ACCESS_MODE=prepared`. Configure OpenAI Secure MCP Tunnel to spawn that stdio command, then install the tunnel as a user LaunchAgent using its generated service definition. Record the exact tunnel-client version and the deployed `obsidian-git-mcp` commit.

The operator must complete two external gates because neither can be derived from repository state:

1. Create or select the OpenAI Platform tunnel, store its runtime key in the local credential location, and confirm the tunnel control plane reports healthy.
2. Add the tunnel endpoint as a private ChatGPT app, enable it for the intended account, and confirm the app appears in a fresh mobile conversation.

Do not treat installation as acceptance. Prove callable tools, daemon health, and a real read-only request before attempting a write.

## Acceptance sequence

Use a disposable note path and unique canary text.

1. From a fresh mobile conversation, call `vault_health` and one exact note read. Record the returned Git SHA.
2. Prepare `create_note` for the disposable path. Verify the preview, affected path, base SHA, and digest before execution.
3. Execute the request. Verify the returned commit SHA exists on remote `main`, then read the note back through the app.
4. Prepare and execute `append_to_section` with a unique canary. Retry the same `requestId` and verify the text appears once and remote `main` advances only once.
5. Prepare another update, advance remote `main` independently, then verify execution fails as stale without changing the target note.
6. Create a new durable `Memory` note after app access, read it back from a separate fresh mobile conversation, and verify the exact remote commit. A Memory that existed before app access does not satisfy this step.

Remove the disposable fixtures after recording the evidence through an ordinary reviewed vault change. Keep the tunnel private throughout the pilot.

## Rollback

Disable or unload the tunnel LaunchAgent, disable the private ChatGPT app, revoke the runtime key, and preserve the dedicated clone plus operation ledger until every `running` or `indeterminate` request is reconciled against Git history. The canonical vault remains GitHub `main`; deleting a service clone never rolls Git history back.
