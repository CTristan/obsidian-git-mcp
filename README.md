# obsidian-git-mcp

An MCP server for git-backed Obsidian vaults. Every write an AI collaborator makes becomes a validated, attributed git commit pushed to the vault's canonical remote — or it doesn't happen at all.

## What does it do?

- Wraps [MCPVault](https://github.com/bitbonsai/mcpvault) in-process for the vault tool surface: search, read, create, patch, frontmatter, and tags.
- Runs every write as a git transaction: lock, verify the checkout is clean, fetch, fast-forward to the remote, apply the change, validate it, commit, push, and return the commit SHA.
- Rolls the checkout back to its pre-transaction state when any step fails, so a failed write leaves nothing behind.
- Refuses conflicting concurrent edits instead of guessing a merge. A push race with a non-conflicting remote commit retries a bounded number of times; an actual conflict stops immediately.
- Attributes each commit to the collaborator that made it, so `git log --author=ChatGPT` is the audit trail. The service itself stays the committer.
- Adds the git-aware tools MCPVault doesn't have: `vault_status`, `list_recent_changes`, and `append_to_section`.
- Ships destructive tools (`delete_note`, `move_note`) disabled by default, and denies `.obsidian/` writes and path traversal at both the path-filter and transaction layers.

## Why create this?

My vault's `main` branch on GitHub is the canonical copy of my second brain, and AI collaborators read and write it directly. The existing git-flavored vault MCP servers either treat the local checkout as a disposable cache the remote overwrites, or batch writes on a debounce timer and push whenever — which means a concurrent edit can silently vanish, and a "successful" write may never reach the remote. That's not acceptable for a vault that multiple agents and my own devices sync against, so this server makes git the transaction boundary: a write either lands as a pushed, attributed, validated commit, or the checkout rolls back and the caller is told why.

## Running it

Point the server at a normal git clone of your vault (never your live Obsidian directory — the checkout is the server's workspace and it will hard-reset it to the remote when recovering from a crash):

```sh
obsidian-git-mcp /path/to/vault-checkout
```

The server speaks MCP over stdio. Configuration comes from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OGM_COLLABORATOR` | *(required)* | Name recorded as the git author of every write |
| `OGM_COLLABORATOR_EMAIL` | derived from the name | Email recorded as the git author |
| `OGM_SERVICE_NAME` | `obsidian-git-mcp` | Name recorded as the git committer |
| `OGM_SERVICE_EMAIL` | `service@obsidian-git-mcp.local` | Email recorded as the git committer |
| `OGM_BRANCH` | `main` | Branch the transaction wrapper syncs and pushes |
| `OGM_REMOTE` | `origin` | Remote the transaction wrapper fetches and pushes |
| `OGM_ALLOW_DESTRUCTIVE` | unset | Set to `1` to expose `delete_note` and `move_note` |

Example Claude Code registration:

```sh
claude mcp add vault -e OGM_COLLABORATOR="Claude Code" -- obsidian-git-mcp /path/to/vault-checkout
```

## Status

Phase 1 spike: the contract-test suite and transaction wrapper are being built TDD-first to decide whether MCPVault stays the underlying tool surface. The verdict and its rationale will be recorded here.
