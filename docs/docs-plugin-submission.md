# obsidian-git-mcp Docs submission

`obsidian-git-mcp Docs` gives ChatGPT and Codex read-only access to the project's current Git-tracked documentation. It answers installation, safety, transaction, wikilink, and contribution questions with direct citations to the deployed documentation corpus.

## Listing

- **Name:** `obsidian-git-mcp Docs`
- **Category:** Developer tools
- **MCP URL:** `https://vault-poc.hemocode.dev/mcp`
- **Authentication:** None
- **Website:** `https://vault-poc.hemocode.dev/`
- **Privacy:** `https://vault-poc.hemocode.dev/privacy`
- **Terms:** `https://vault-poc.hemocode.dev/terms`
- **Support:** `https://vault-poc.hemocode.dev/support`
- **Description:** Search and read the current `obsidian-git-mcp` documentation, including its git transaction guarantees, safety boundaries, installation instructions, wikilink behavior, and contribution requirements.

## Tool annotations

Both tools set `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, and `idempotentHint: true` because they read a fixed local corpus, never change state, never contact another service, and return the same result for the same deployed revision.

`search` accepts one bounded query string and returns matching document IDs, titles, and canonical citation URLs. `fetch` accepts one document ID returned by `search` and returns the exact Markdown, title, URL, and format metadata.

## Positive tests

1. Search for the installation requirements, then cite the relevant documentation.
2. Find the reason writes use git transactions and explain the guarantee.
3. Find how ambiguous wikilinks behave and cite the governing decision.
4. Find the contribution test commands and list them in order.
5. Fetch the mobile compatibility note and reproduce its verification phrase exactly.

## Negative tests

1. Ask the plugin to edit a vault note. It must explain that the service is read-only and expose no write tool.
2. Ask for a private vault's contents. It must explain that the corpus contains only public project documentation.
3. Ask `fetch` for an invented document ID. It must return an explicit not-found tool error without guessing.

## Release checklist

1. Deploy the exact reviewed commit and verify `/healthz`, `/mcp`, every citation page, and every policy page over HTTPS.
2. Configure the domain challenge token, complete domain verification, and remove no required route afterward.
3. Run MCP Inspector against the production URL and call both tools with every positive and negative test.
4. Confirm the publisher identity and Apps Management write access in the Platform organization.
5. Scan the production tools in the submission portal and verify that the discovered schemas and annotations match this document.
6. Submit the plugin for review, then publish only the approved metadata snapshot.
7. Connect the published version on ChatGPT Pro for iOS and run the mobile acceptance procedure in `docs/mobile-compatibility.md` from both a new and an existing conversation.
