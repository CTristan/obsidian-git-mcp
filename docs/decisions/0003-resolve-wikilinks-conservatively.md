# 3. Resolve wikilinks conservatively from a clean vault index

Accepted 2026-07-26 for the first wrapper-native read tools.

## Context

`resolve_wikilink` and `get_backlinks` need to agree on what a wikilink points at, because a
backlink is only useful when its forward link resolves to the same note. Obsidian documents the
surface syntax (paths, aliases, headings, and block references), but its resolver is closed source.
That leaves ambiguous filename ranking undocumented, which means copying a plausible "nearest
note" heuristic would turn uncertainty into a confident wrong answer.

The server also serves a git checkout that can fast-forward before a read. Building the vault index
outside `Transactor.readTransaction()` would race that update, while caching only by `HEAD` would
miss uncommitted changes when the checkout is dirty.

## Considered options

- **Choose the nearest duplicate note.** This is convenient, but "nearest" has several reasonable
  definitions and none are an API contract we can verify. Rejected because a deterministic guess
  is still a guess.
- **Require a full vault path for every link.** This removes ambiguity, but it rejects the
  shortest-unique links Obsidian creates and makes same-note references needlessly awkward.
- **Run Obsidian to resolve every link.** This would make Obsidian the oracle, but it requires the
  desktop application and turns a headless MCP server into an Obsidian plugin by another name.
- **Resolve only from explicit evidence.** Exact paths, unique path suffixes, same-note references,
  and exact same-directory matches are safe to return. Any remaining duplicate stays ambiguous.

## Adversarial review

The initial design used the source note's deepest shared directory to rank duplicate filenames.
That fails when two equally named notes sit at different conceptual scopes, because directory
proximity does not prove authorial intent. The resolver now accepts a duplicate only when the
source directory contains an exact matching note; every other tie returns the candidates in an
error.

A `HEAD`-keyed cache also fails when another process leaves the checkout dirty without advancing
`HEAD`. `readTransaction()` now captures the dirty flag inside the same lock as the read. Clean
snapshots may reuse an index for their `HEAD`; dirty snapshots always rebuild and never populate
the cache. The index enumerates tracked Markdown notes with `git ls-files`, so an ignored file can
neither enter the canonical vault index nor change underneath a clean `HEAD` cache entry.

Subpath validation and backlinks deliberately answer different questions. `resolve_wikilink`
rejects a missing heading or block because the complete link is broken. `get_backlinks` still
counts that source against the resolved note because the file part remains a note-level link.

Finally, the parser only scans Markdown text nodes. Frontmatter, code, HTML nodes, and Obsidian
`%%` comments cannot create backlinks, while embeds count because Obsidian treats them as links to
the embedded file. A pipe alias is display text, never a second destination; frontmatter aliases
stay out of resolution because Obsidian writes their selected links with the canonical destination.

## Decision outcome

Build an in-memory index inside `Transactor.readTransaction()` with
`mdast-util-from-markdown@2.0.3` (MIT) as the CommonMark parser. The wrapper scans text nodes for
Obsidian wikilinks, records headings and block identifiers, and keeps the original vault-relative
path for every note.

Resolution checks an explicit vault path first when the target contains a directory, then an exact
path relative to the source note's directory, then a unique extensionless path suffix. A bare
filename never prefers the vault root merely because a same-named root note exists. An empty target
resolves to the source note for same-note heading and block links. Matching stays case-sensitive,
`..` traversal stays forbidden, and a duplicate that survives those checks returns an error with
its candidates.

`resolve_wikilink` accepts one complete `[[wikilink]]` (or `![[embed]]`) plus an optional exact
`sourcePath`. It returns the resolved path, validated heading or block subpath, and display alias.
Heading segments match their rendered text exactly and follow the document hierarchy when a link
contains multiple `#` segments; block identifiers match exactly after `#^`.
`get_backlinks` accepts an exact note path and returns unique source paths in lexical order. Both
results carry the `HEAD` SHA captured by the read transaction.

## Consequences

- Good, because uncertain duplicates fail visibly instead of silently pointing at the wrong note.
- Good, because `resolve_wikilink` and `get_backlinks` share one parser and resolver.
- Good, because the cache cannot hide dirty worktree changes or cross a `HEAD` update.
- Good, because CommonMark decides which regions contain normal text, so examples in code blocks
  cannot become backlinks.
- Good, because ignored and untracked files cannot leak into an index that represents the canonical
  git-backed vault.
- Bad, because undocumented Obsidian ranking may resolve a link that this server reports as
  ambiguous. The refusal is intentional because returning no path is safer than returning the
  wrong one.
- Bad, because the first index build reads every Markdown note. Clean reads reuse that work until
  `HEAD` changes, while dirty reads pay the full cost every time to preserve correctness.
