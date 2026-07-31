import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface CanaryCatalogEntry {
  id: string;
  path: string;
  title: string;
}

export interface CanaryDocument {
  id: string;
  text: string;
  title: string;
  url: string;
}

export interface CanarySearchResult {
  id: string;
  title: string;
  url: string;
}

export interface CanaryCatalog {
  documents(): readonly CanaryDocument[];
  fetch(id: string): CanaryDocument | undefined;
  search(query: string): CanarySearchResult[];
}

export const CANARY_CATALOG_ENTRIES: readonly CanaryCatalogEntry[] = [
  { id: 'overview', path: 'README.md', title: 'obsidian-git-mcp overview' },
  { id: 'contributing', path: 'CONTRIBUTING.md', title: 'Contributing guide' },
  {
    id: 'wrap-mcpvault',
    path: 'docs/decisions/0001-wrap-mcpvault.md',
    title: 'ADR 0001: Wrap MCPVault',
  },
  {
    id: 'gitignored-writes',
    path: 'docs/decisions/0002-refuse-gitignored-writes-before-live-mutation.md',
    title: 'ADR 0002: Refuse gitignored writes',
  },
  {
    id: 'wikilink-resolution',
    path: 'docs/decisions/0003-resolve-wikilinks-conservatively.md',
    title: 'ADR 0003: Resolve wikilinks conservatively',
  },
  {
    id: 'docstring-coverage',
    path: 'docs/decisions/0004-enforce-source-docstring-coverage.md',
    title: 'ADR 0004: Enforce source docstring coverage',
  },
  {
    id: 'mobile-compatibility',
    path: 'docs/mobile-compatibility.md',
    title: 'Mobile compatibility',
  },
];

/** Normalizes searchable text without changing the returned Markdown. */
function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

/** Extracts unique Unicode word terms for deterministic OR matching. */
function queryTerms(query: string): string[] {
  return [...new Set(normalize(query).match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

/** Scores phrase, title, and body matches with title matches weighted highest. */
function scoreDocument(document: CanaryDocument, query: string, terms: readonly string[]): number {
  const title = normalize(document.title);
  const text = normalize(document.text);
  const phrase = normalize(query.trim());
  let score = phrase !== '' && title.includes(phrase) ? 20 : 0;
  if (phrase !== '' && text.includes(phrase)) score += 8;
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (text.includes(term)) score += 1;
  }
  return score;
}

/** Validates and freezes one document before it enters the public catalog. */
function validateDocument(document: CanaryDocument): CanaryDocument {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.id)) {
    throw new Error(`invalid document ID: ${JSON.stringify(document.id)}`);
  }
  if (document.title.trim() === '' || document.text.trim() === '') {
    throw new Error(`document ${JSON.stringify(document.id)} must have a title and text`);
  }
  const url = new URL(document.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`document ${JSON.stringify(document.id)} must use an HTTP(S) URL`);
  }
  return Object.freeze({ ...document });
}

/** Builds the immutable search and fetch view over already-loaded Markdown documents. */
export function createCanaryCatalogFromDocuments(documents: readonly CanaryDocument[]): CanaryCatalog {
  const ordered = Object.freeze(documents.map(validateDocument));
  const byId = new Map(ordered.map((document) => [document.id, document]));
  if (byId.size !== ordered.length) throw new Error('document IDs must be unique');

  return Object.freeze({
    /** Returns the exact ordered corpus used by search and citation pages. */
    documents(): readonly CanaryDocument[] {
      return ordered;
    },
    /** Returns one exact document without approximating an unknown identifier. */
    fetch(id: string): CanaryDocument | undefined {
      return byId.get(id);
    },
    /** Ranks title and body matches deterministically without external indexing. */
    search(query: string): CanarySearchResult[] {
      const terms = queryTerms(query);
      if (terms.length === 0) return [];
      return ordered
        .map((document) => ({ document, score: scoreDocument(document, query, terms) }))
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.document.title.localeCompare(right.document.title, 'en-US') ||
            left.document.id.localeCompare(right.document.id, 'en-US'),
        )
        .slice(0, 10)
        .map(({ document }) => ({ id: document.id, title: document.title, url: document.url }));
    },
  });
}

/** Resolves one manifest path while refusing absolute paths and traversal. */
function containedPath(root: string, path: string): string {
  if (path === '' || isAbsolute(path)) throw new Error('catalog paths must be contained relative paths');
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('catalog paths must be contained relative paths');
  }
  return candidate;
}

/** Loads an allowlisted Git-tracked Markdown corpus from disk. */
export async function createCanaryCatalog(options: {
  baseUrl: string;
  entries?: readonly CanaryCatalogEntry[];
  root: string;
}): Promise<CanaryCatalog> {
  const baseUrl = new URL(options.baseUrl);
  const entries = options.entries ?? CANARY_CATALOG_ENTRIES;
  const documents = await Promise.all(
    entries.map(async (entry) => ({
      id: entry.id,
      text: await readFile(containedPath(options.root, entry.path), 'utf8'),
      title: entry.title,
      url: new URL(`/notes/${encodeURIComponent(entry.id)}`, baseUrl).href,
    })),
  );
  return createCanaryCatalogFromDocuments(documents);
}
