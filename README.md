# obsidian-git-mcp

An MCP server for git-backed Obsidian vaults. Every write an AI collaborator makes becomes a validated, attributed git commit pushed to the vault's canonical remote — or it doesn't happen at all.

## What does it do?

- Wraps [MCPVault](https://github.com/bitbonsai/mcpvault) in-process for the vault tool surface: search, read, create, patch, frontmatter, and tags.
- Runs every write as a git transaction: lock, verify the checkout is clean, fetch, fast-forward to the remote, apply the change, validate it, commit, push, and return the commit SHA.
- Rolls the checkout back to its pre-transaction state when any step fails, so a failed write leaves nothing behind.
- Refuses conflicting concurrent edits instead of guessing a merge. A push race with a non-conflicting remote commit retries a bounded number of times; an actual conflict stops immediately.
- Attributes each commit to the collaborator that made it, so `git log --author=ChatGPT` is the audit trail. The service itself stays the committer.
- Adds the git-aware tools MCPVault doesn't have: `vault_status`, `list_recent_changes`, and `append_to_section`.
- Ships destructive tools (`delete_note`, `move_note`, `move_file`) disabled by default, and denies `.obsidian/` writes and path traversal at both the path-filter and transaction layers.

## Why create this?

My vault's `main` branch on GitHub is the canonical copy of my second brain, and AI collaborators read and write it directly. The existing git-flavored vault MCP servers either treat the local checkout as a disposable cache the remote overwrites, or batch writes on a debounce timer and push whenever — which means a concurrent edit can silently vanish, and a "successful" write may never reach the remote. That's not acceptable for a vault that multiple agents and my own devices sync against, so this server makes git the transaction boundary: a write either lands as a pushed, attributed, validated commit, or the checkout rolls back and the caller is told why.

The full build-vs-wrap evaluation — why the server wraps MCPVault instead of forking one of those servers — is recorded in [docs/decisions/0001-wrap-mcpvault.md](docs/decisions/0001-wrap-mcpvault.md).

## Installing

Not on npm yet, so install from source. You need Node ≥ 24, pnpm, and git ≥ 2.15 on `PATH`.

Git ≥ 2.15 supplies `git --no-optional-locks status`, which the transaction wrapper runs before serving anything. The wrapper also relies on the `--porcelain=v1` status format from git 2.11 and `core.hooksPath` host-hook suppression from git 2.9. Contributing needs git ≥ 2.32 for the test fixtures' `GIT_CONFIG_GLOBAL` isolation (see [CONTRIBUTING.md](CONTRIBUTING.md)).

pnpm isn't bundled with Node, so enable it via Corepack. Which command you run depends on your Node version, because Node 25 dropped the bundled Corepack that earlier versions ship:

- **Node ≤ 24:** run `corepack enable pnpm` directly. Reach for `npm install --global corepack@latest` first only if that bundled Corepack is too stale to enable current pnpm releases, because on a version that already bundles Corepack the global install can clash with the existing shims.
- **Node 25+:** install Corepack first with `npm install --global corepack@latest`, then run `corepack enable pnpm`.

Or skip Corepack entirely and use pnpm's own installer at <https://pnpm.io/installation>. Once pnpm is available:

```sh
git clone https://github.com/CTristan/obsidian-git-mcp.git
cd obsidian-git-mcp
pnpm install --frozen-lockfile && pnpm build
```

The build does not put `obsidian-git-mcp` on `PATH`. Run `pnpm link --global` from the repo to get the bare command, or use `node /path/to/obsidian-git-mcp/dist/cli.js` directly — the examples below show the direct form because it works without any extra step.

## Running it

Point the server at a normal git clone of your vault, never your live Obsidian directory. Clone the vault's remote to make that checkout:

```sh
git clone <your-vault-remote> /path/to/vault-checkout
```

The checkout is the server's workspace: on startup it discards any leftover crash debris — uncommitted edits and unpushed commits alike — by hard-resetting to the remote, because a write that never reached the remote never counted. Aim it at your live vault and that reset takes your local-only notes with it.

```sh
OGM_COLLABORATOR="Your Name" node /path/to/obsidian-git-mcp/dist/cli.js /path/to/vault-checkout
```

That example assumes your vault's canonical branch is `main` — set `OGM_BRANCH` to your branch name if it differs, because the startup sync fetches and fast-forwards that branch and fails against one that doesn't exist.

The server speaks MCP over stdio. Configuration comes from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OGM_COLLABORATOR` | *(required)* | Name recorded as the git author of every write |
| `OGM_COLLABORATOR_EMAIL` | derived from the name | Email recorded as the git author |
| `OGM_SERVICE_NAME` | `obsidian-git-mcp` | Name recorded as the git committer |
| `OGM_SERVICE_EMAIL` | `service@obsidian-git-mcp.local` | Email recorded as the git committer |
| `OGM_BRANCH` | `main` | Branch the transaction wrapper syncs and pushes |
| `OGM_REMOTE` | `origin` | Remote the transaction wrapper fetches and pushes |
| `OGM_ALLOW_DESTRUCTIVE` | unset | Set to `1` to expose `delete_note`, `move_note`, and `move_file` |

Example Claude Code registration:

```sh
claude mcp add vault -e OGM_COLLABORATOR="Claude Code" -- node /path/to/obsidian-git-mcp/dist/cli.js /path/to/vault-checkout
```

## Behavior notes

Two tool behaviors worth knowing before you write:

- `update_frontmatter` preserves sibling keys and their data but normalizes flow-style whitespace (`[project]` becomes `[ project ]`), so frontmatter updates are semantically targeted, not byte-targeted. The note body stays byte-identical.
- `patch_note` is exact-string replace (`oldString`/`newString`), not heading-targeted. That works well in practice, because agents read a note before editing it, and reproducing exact bytes is more reliable for them than heading arithmetic.

`get_backlinks` and `resolve_wikilink` aren't implemented yet — they're tracked in [#2](https://github.com/CTristan/obsidian-git-mcp/issues/2).
