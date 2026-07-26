import { describe, expect, it } from 'vitest';
import {
  backlinksFor,
  createWikilinkIndex,
  resolveWikilink,
  type VaultNote,
} from '../../src/wikilinks.js';

function index(notes: Record<string, string>) {
  return createWikilinkIndex(
    Object.entries(notes).map(([path, content]): VaultNote => ({ path, content })),
  );
}

describe('resolveWikilink', () => {
  it('resolves exact, same-directory, and shortest-unique paths without guessing ties', () => {
    const vault = index({
      'Root.md': '# Root\n',
      'Folder/Source.md': '# Source\n',
      'Folder/Target.md': '# Local target\n',
      'Other/Target.md': '# Other target\n',
      'Archive/Nested/Unique.md': '# Unique\n',
    });

    expect(resolveWikilink(vault, '[[Folder/Target]]')).toEqual({
      path: 'Folder/Target.md',
      subpath: null,
      alias: null,
    });
    expect(resolveWikilink(vault, '[[Target]]', 'Folder/Source.md').path).toBe(
      'Folder/Target.md',
    );
    expect(resolveWikilink(vault, '[[Nested/Unique]]').path).toBe(
      'Archive/Nested/Unique.md',
    );
    expect(() => resolveWikilink(vault, '[[Target]]')).toThrow(
      /ambiguous.*Folder\/Target\.md.*Other\/Target\.md/i,
    );
  });

  it('does not prefer a same-named root note for a bare ambiguous filename', () => {
    const vault = index({
      'Target.md': '# Root target\n',
      'Other/Target.md': '# Other target\n',
    });

    expect(() => resolveWikilink(vault, '[[Target]]')).toThrow(/ambiguous/i);
  });

  it('parses aliases and validates nested headings and blocks', () => {
    const vault = index({
      'Source.md': '# Source\n',
      'Target.md': [
        '# Parent',
        '',
        '## Child *with emphasis*',
        '',
        'A referenced paragraph. ^block-id',
        '',
        '# Other',
        '',
        '## Child *with emphasis*',
        '',
        '# C#',
        '',
      ].join('\n'),
    });

    expect(
      resolveWikilink(vault, '[[Target#Parent#Child with emphasis|Readable]]'),
    ).toEqual({
      path: 'Target.md',
      subpath: { type: 'heading', value: 'Parent#Child with emphasis' },
      alias: 'Readable',
    });
    expect(resolveWikilink(vault, '[[Target#^block-id]]')).toEqual({
      path: 'Target.md',
      subpath: { type: 'block', value: 'block-id' },
      alias: null,
    });
    expect(resolveWikilink(vault, String.raw`[[Target#C\#]]`).subpath).toEqual({
      type: 'heading',
      value: 'C#',
    });
    expect(() => resolveWikilink(vault, '[[Target#Missing]]')).toThrow(
      /heading.*Missing.*not found/i,
    );
    expect(() => resolveWikilink(vault, '[[Target#^missing]]')).toThrow(
      /block.*missing.*not found/i,
    );
  });

  it('uses sourcePath for same-note heading and block links', () => {
    const vault = index({
      'Folder/Source.md': '# Local\n\nParagraph. ^local-block\n',
    });

    expect(resolveWikilink(vault, '[[#Local]]', 'Folder/Source.md').path).toBe(
      'Folder/Source.md',
    );
    expect(resolveWikilink(vault, '[[#^local-block]]', 'Folder/Source.md').subpath).toEqual({
      type: 'block',
      value: 'local-block',
    });
    expect(() => resolveWikilink(vault, '[[#Local]]')).toThrow(/sourcePath/i);
  });

  it('requires a complete wikilink and refuses traversal and case guesses', () => {
    const vault = index({
      'Target.md': '# Target\n',
      'target-lower.md': '# Lower\n',
    });

    expect(() => resolveWikilink(vault, 'Target')).toThrow(/complete.*wikilink/i);
    expect(() => resolveWikilink(vault, '[[../Target]]')).toThrow(/traversal/i);
    expect(() => resolveWikilink(vault, '[[TARGET]]')).toThrow(/not found/i);
  });
});

describe('backlinksFor', () => {
  it('deduplicates sources and counts embeds and broken subpaths as note backlinks', () => {
    const vault = index({
      'Target.md': '# Existing\n',
      'A.md': '[[Target]] and [[Target#Missing|broken heading]]\n',
      'B.md': '![[Target#Existing]]\n',
    });

    expect(backlinksFor(vault, 'Target.md')).toEqual(['A.md', 'B.md']);
  });

  it('ignores wikilink-looking text outside normal Markdown text', () => {
    const vault = index({
      'Visible.md': '# Visible\n',
      'Frontmatter.md': '# Frontmatter\n',
      'InlineCode.md': '# Inline code\n',
      'Fence.md': '# Fence\n',
      'Comment.md': '# Comment\n',
      'HtmlComment.md': '# HTML comment\n',
      'AfterLiteralPercent.md': '# After literal percent\n',
      'Escaped.md': '# Escaped\n',
      'Source.md': [
        '---',
        'related: "[[Frontmatter]]"',
        '---',
        '',
        '[[Visible]]',
        '',
        '`[[InlineCode]]`',
        '',
        '```md',
        '[[Fence]]',
        '```',
        '',
        '%% [[Comment]] %%',
        '',
        '<!-- [[HtmlComment]] -->',
        '',
        '`%%` [[AfterLiteralPercent]]',
        '',
        '\\[[Escaped]]',
        '',
      ].join('\n'),
    });

    expect(backlinksFor(vault, 'Visible.md')).toEqual(['Source.md']);
    expect(backlinksFor(vault, 'Frontmatter.md')).toEqual([]);
    expect(backlinksFor(vault, 'InlineCode.md')).toEqual([]);
    expect(backlinksFor(vault, 'Fence.md')).toEqual([]);
    expect(backlinksFor(vault, 'Comment.md')).toEqual([]);
    expect(backlinksFor(vault, 'HtmlComment.md')).toEqual([]);
    expect(backlinksFor(vault, 'AfterLiteralPercent.md')).toEqual(['Source.md']);
    expect(backlinksFor(vault, 'Escaped.md')).toEqual([]);
  });

  it('ignores ambiguous and malformed links instead of inventing a backlink', () => {
    const vault = index({
      'One/Target.md': '# One\n',
      'Two/Target.md': '# Two\n',
      'Source.md': '[[Target]] [[never closes\n',
    });

    expect(backlinksFor(vault, 'One/Target.md')).toEqual([]);
    expect(backlinksFor(vault, 'Two/Target.md')).toEqual([]);
  });

  it('finds a valid nested link after a malformed outer candidate', () => {
    const vault = index({
      'Visible.md': '# Visible\n',
      'Source.md': '[[never closes [[Visible]]\n',
    });

    expect(backlinksFor(vault, 'Visible.md')).toEqual(['Source.md']);
  });
});
