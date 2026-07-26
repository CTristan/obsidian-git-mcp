import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { forbiddenPathReason } from './paths.js';

const NOTE_EXTENSIONS = ['.md', '.markdown'] as const;
const BLOCK_ID = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface VaultNote {
  path: string;
  content: string;
}

export type WikilinkSubpath =
  | { type: 'heading'; value: string }
  | { type: 'block'; value: string };

export interface ResolvedWikilink {
  path: string;
  subpath: WikilinkSubpath | null;
  alias: string | null;
}

interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

interface OffsetRange {
  start: number;
  end: number;
}

interface Heading {
  depth: number;
  text: string;
}

interface ParsedWikilink {
  raw: string;
  target: string;
  subpath: WikilinkSubpath | null;
  alias: string | null;
  embed: boolean;
  headingSegments?: string[];
}

interface IndexedNote extends VaultNote {
  headings: Heading[];
  blocks: Set<string>;
  links: ParsedWikilink[];
}

export interface WikilinkIndex {
  readonly notes: ReadonlyMap<string, IndexedNote>;
  readonly notesBySuffix: ReadonlyMap<string, readonly IndexedNote[]>;
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return NOTE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function stripNoteExtension(path: string): string {
  const lower = path.toLowerCase();
  for (const extension of NOTE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return path.slice(0, -extension.length);
    }
  }
  return path;
}

function maskRange(content: string, start: number, end: number): string {
  return (
    content.slice(0, start) +
    content
      .slice(start, end)
      .replace(/[^\r\n]/g, ' ') +
    content.slice(end)
  );
}

/** Masks YAML frontmatter without changing offsets used by mdast positions. */
function maskFrontmatter(content: string): string {
  const firstLineEnd = content.indexOf('\n');
  const firstLine = content.slice(0, firstLineEnd === -1 ? content.length : firstLineEnd);
  if (firstLine.replace(/\r$/, '').trim() !== '---') return content;

  let offset = firstLineEnd === -1 ? content.length : firstLineEnd + 1;
  while (offset < content.length) {
    const next = content.indexOf('\n', offset);
    const end = next === -1 ? content.length : next;
    if (content.slice(offset, end).replace(/\r$/, '').trim() === '---') {
      return maskRange(content, 0, next === -1 ? end : next + 1);
    }
    if (next === -1) break;
    offset = next + 1;
  }
  return content;
}

function isEscaped(value: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && value[index] === '\\'; index--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

function commentProtectedRanges(tree: MarkdownNode): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return ranges.sort((left, right) => left.start - right.start);
}

/** Masks Obsidian %% comments while preserving line and byte offsets. */
function maskObsidianComments(content: string, protectedRanges: readonly OffsetRange[]): string {
  let result = content;
  let open: number | undefined;
  let protectedIndex = 0;
  const isProtected = (offset: number): boolean => {
    while (
      protectedIndex < protectedRanges.length &&
      protectedRanges[protectedIndex]!.end <= offset
    ) {
      protectedIndex++;
    }
    const range = protectedRanges[protectedIndex];
    return range !== undefined && range.start <= offset && offset < range.end;
  };
  for (let index = 0; index < content.length - 1; index++) {
    if (
      content[index] !== '%' ||
      content[index + 1] !== '%' ||
      isEscaped(content, index) ||
      isProtected(index) ||
      isProtected(index + 1)
    ) {
      continue;
    }
    if (open === undefined) {
      open = index;
      index++;
      continue;
    }
    result = maskRange(result, open, index + 2);
    open = undefined;
    index++;
  }
  return open === undefined ? result : maskRange(result, open, result.length);
}

function findUnescaped(value: string, wanted: string, start = 0): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] === wanted && !isEscaped(value, index)) return index;
  }
  return -1;
}

function splitUnescaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === separator && !isEscaped(value, index)) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unescapeWikilinkText(value: string): string {
  return value.replace(/\\([\\|#[\]])/g, '$1');
}

function parseWikilinkBody(raw: string, body: string, embed: boolean): ParsedWikilink | undefined {
  if (body.includes('[[') || body.includes(']]')) return undefined;
  const pipe = findUnescaped(body, '|');
  const destinationRaw = pipe === -1 ? body : body.slice(0, pipe);
  const alias =
    pipe === -1 ? null : unescapeWikilinkText(body.slice(pipe + 1)).trim();
  const hash = findUnescaped(destinationRaw, '#');
  const targetRaw = hash === -1 ? destinationRaw : destinationRaw.slice(0, hash);
  const subpathRaw = hash === -1 ? undefined : destinationRaw.slice(hash + 1);
  const target = unescapeWikilinkText(targetRaw).trim();

  let subpath: WikilinkSubpath | null = null;
  let headingSegments: string[] | undefined;
  if (subpathRaw !== undefined) {
    const unescaped = unescapeWikilinkText(subpathRaw).trim();
    if (unescaped === '') return undefined;
    if (unescaped.startsWith('^')) {
      subpath = { type: 'block', value: unescaped.slice(1) };
    } else {
      headingSegments = splitUnescaped(subpathRaw, '#').map((segment) =>
        unescapeWikilinkText(segment).trim(),
      );
      subpath = { type: 'heading', value: headingSegments.join('#') };
    }
    if (subpath.value === '') return undefined;
    if (headingSegments?.some((segment) => segment === '')) return undefined;
  }

  return { raw, target, subpath, alias, embed, headingSegments };
}

function scanWikilinks(value: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  for (let index = 0; index < value.length - 1; index++) {
    const embed = value[index] === '!' && value[index + 1] === '[' && value[index + 2] === '[';
    const start = embed ? index + 1 : index;
    if (
      value[start] !== '[' ||
      value[start + 1] !== '[' ||
      isEscaped(value, start)
    ) {
      continue;
    }

    let close = -1;
    for (let cursor = start + 2; cursor < value.length - 1; cursor++) {
      if (
        value[cursor] === ']' &&
        value[cursor + 1] === ']' &&
        !isEscaped(value, cursor)
      ) {
        close = cursor;
        break;
      }
    }
    if (close === -1) continue;

    const rawStart = embed ? index : start;
    const raw = value.slice(rawStart, close + 2);
    const parsed = parseWikilinkBody(raw, value.slice(start + 2, close), embed);
    if (parsed) {
      links.push(parsed);
      index = close + 1;
    }
  }
  return links;
}

function nodeText(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value;
  if (typeof node.alt === 'string') return node.alt;
  return (node.children ?? []).map(nodeText).join('');
}

function parseNote(note: VaultNote): IndexedNote {
  const withoutFrontmatter = maskFrontmatter(note.content);
  const initialTree = fromMarkdown(withoutFrontmatter) as MarkdownNode;
  const masked = withoutFrontmatter.includes('%%')
    ? maskObsidianComments(withoutFrontmatter, commentProtectedRanges(initialTree))
    : withoutFrontmatter;
  const tree = masked === withoutFrontmatter ? initialTree : (fromMarkdown(masked) as MarkdownNode);
  const headings: Heading[] = [];
  const blocks = new Set<string>();
  const links: ParsedWikilink[] = [];

  const visit = (node: MarkdownNode): void => {
    if (node.type === 'heading' && typeof node.depth === 'number') {
      headings.push({ depth: node.depth, text: nodeText(node).trim() });
    }
    if (node.type === 'text' && typeof node.value === 'string') {
      const block = BLOCK_ID.exec(node.value);
      if (block?.[1]) blocks.add(block[1]);

      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        links.push(...scanWikilinks(masked.slice(start, end)));
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);

  return { ...note, headings, blocks, links };
}

export function createWikilinkIndex(notes: readonly VaultNote[]): WikilinkIndex {
  const indexed = new Map<string, IndexedNote>();
  const notesBySuffix = new Map<string, IndexedNote[]>();
  for (const note of [...notes].sort((left, right) => comparePaths(left.path, right.path))) {
    const path = note.path.replaceAll('\\', '/');
    if (!isMarkdownPath(path)) continue;
    if (indexed.has(path)) {
      throw new Error(`duplicate vault note path: ${path}`);
    }
    const parsed = parseNote({ path, content: note.content });
    indexed.set(path, parsed);

    const stemSegments = stripNoteExtension(path).split('/');
    for (let index = 0; index < stemSegments.length; index++) {
      const suffix = stemSegments.slice(index).join('/');
      const candidates = notesBySuffix.get(suffix);
      if (candidates) {
        candidates.push(parsed);
      } else {
        notesBySuffix.set(suffix, [parsed]);
      }
    }
  }
  return { notes: indexed, notesBySuffix };
}

function notePathVariants(path: string): string[] {
  return isMarkdownPath(path) ? [path] : NOTE_EXTENSIONS.map((extension) => `${path}${extension}`);
}

function exactNote(index: WikilinkIndex, path: string): IndexedNote | undefined {
  for (const variant of notePathVariants(path)) {
    const note = index.notes.get(variant);
    if (note) return note;
  }
  return undefined;
}

function assertSourceNote(index: WikilinkIndex, sourcePath: string | undefined): IndexedNote | undefined {
  if (sourcePath === undefined) return undefined;
  const normalized = sourcePath.replaceAll('\\', '/');
  const reason = forbiddenPathReason(normalized);
  if (reason) throw new Error(`${sourcePath}: ${reason}`);
  const source = index.notes.get(normalized);
  if (!source) {
    throw new Error(`sourcePath is not an indexed note: ${sourcePath}`);
  }
  return source;
}

function resolveTarget(
  index: WikilinkIndex,
  target: string,
  sourcePath?: string,
): IndexedNote {
  const source = assertSourceNote(index, sourcePath);
  if (target === '') {
    if (!source) throw new Error('sourcePath is required for a same-note wikilink');
    return source;
  }

  const slashed = target.replaceAll('\\', '/');
  const reason = forbiddenPathReason(slashed);
  if (reason) throw new Error(`${target}: ${reason}`);
  const normalized = posix.normalize(slashed);

  // A directory-bearing target is an explicit vault path. A bare filename is not: if a
  // same-named note exists elsewhere, preferring the root would be an undocumented guess.
  if (normalized.includes('/')) {
    const explicit = exactNote(index, normalized);
    if (explicit) return explicit;
  }

  if (source) {
    const besideSource = exactNote(index, posix.join(posix.dirname(source.path), normalized));
    if (besideSource) return besideSource;
  }

  const wanted = stripNoteExtension(normalized);
  const candidates = index.notesBySuffix.get(wanted) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`wikilink target not found: ${target}`);
  }
  const paths = candidates.map((note) => note.path).sort(comparePaths);
  throw new Error(`wikilink target is ambiguous: ${target} (${paths.join(', ')})`);
}

function hasHeadingPath(note: IndexedNote, segments: readonly string[]): boolean {
  const matchesFrom = (headingIndex: number, segmentIndex: number): boolean => {
    if (segmentIndex === segments.length - 1) return true;
    const parent = note.headings[headingIndex]!;
    let boundary = note.headings.length;
    for (let index = headingIndex + 1; index < note.headings.length; index++) {
      if (note.headings[index]!.depth <= parent.depth) {
        boundary = index;
        break;
      }
    }
    for (let index = headingIndex + 1; index < boundary; index++) {
      const candidate = note.headings[index]!;
      if (
        candidate.depth > parent.depth &&
        candidate.text === segments[segmentIndex + 1] &&
        matchesFrom(index, segmentIndex + 1)
      ) {
        return true;
      }
    }
    return false;
  };

  return note.headings.some(
    (heading, index) => heading.text === segments[0] && matchesFrom(index, 0),
  );
}

function parseCompleteWikilink(link: string): ParsedWikilink {
  const trimmed = link.trim();
  const parsed = scanWikilinks(trimmed);
  if (parsed.length !== 1 || parsed[0]!.raw !== trimmed) {
    throw new Error('link must be one complete [[wikilink]] or ![[embed]]');
  }
  return parsed[0]!;
}

export function resolveWikilink(
  index: WikilinkIndex,
  link: string,
  sourcePath?: string,
): ResolvedWikilink {
  const parsed = parseCompleteWikilink(link);
  const note = resolveTarget(index, parsed.target, sourcePath);
  if (
    parsed.subpath?.type === 'heading' &&
    !hasHeadingPath(note, parsed.headingSegments ?? [parsed.subpath.value])
  ) {
    throw new Error(`heading "${parsed.subpath.value}" not found in ${note.path}`);
  }
  if (parsed.subpath?.type === 'block' && !note.blocks.has(parsed.subpath.value)) {
    throw new Error(`block "${parsed.subpath.value}" not found in ${note.path}`);
  }
  return { path: note.path, subpath: parsed.subpath, alias: parsed.alias };
}

export function backlinksFor(index: WikilinkIndex, targetPath: string): string[] {
  const normalized = targetPath.replaceAll('\\', '/');
  const reason = forbiddenPathReason(normalized);
  if (reason) throw new Error(`${targetPath}: ${reason}`);
  if (!index.notes.has(normalized)) {
    throw new Error(`backlink target is not an indexed note: ${targetPath}`);
  }

  const backlinks = new Set<string>();
  for (const source of index.notes.values()) {
    for (const link of source.links) {
      try {
        if (resolveTarget(index, link.target, source.path).path === normalized) {
          backlinks.add(source.path);
          break;
        }
      } catch {
        // An unresolved or ambiguous link is not a backlink. Keep scanning the source in
        // case a later, independently resolvable link names the target.
      }
    }
  }
  return [...backlinks].sort(comparePaths);
}
