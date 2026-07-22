import { describe, expect, it } from 'vitest';
import { forbiddenPathReason } from '../../src/paths.js';

describe('forbiddenPathReason', () => {
  it('refuses traversal, absolute paths, and restricted directories', () => {
    expect(forbiddenPathReason('../outside.md')).toBeDefined();
    // Interior traversal too — normalize() would silently collapse it, and the
    // contract is that '..' never appears in an accepted path.
    expect(forbiddenPathReason('notes/../draft.md')).toBeDefined();
    expect(forbiddenPathReason('/etc/hosts')).toBeDefined();
    // Windows drive forms — absolute, backslash, and drive-relative alike.
    expect(forbiddenPathReason('C:/outside.md')).toBeDefined();
    expect(forbiddenPathReason('C:\\outside.md')).toBeDefined();
    expect(forbiddenPathReason('C:relative.md')).toBeDefined();
    expect(forbiddenPathReason('.git/config')).toBeDefined();
    expect(forbiddenPathReason('.obsidian/app.json')).toBeDefined();
    expect(forbiddenPathReason('nested/.obsidian/app.json')).toBeDefined();
  });

  it('refuses Windows trailing-dot and trailing-space aliases of restricted directories', () => {
    // Win32 strips trailing dots and spaces from path segments, so ".git." and
    // ".git " resolve to ".git" on disk — exact matching alone would miss them.
    expect(forbiddenPathReason('.git./config')).toBeDefined();
    expect(forbiddenPathReason('.git /config')).toBeDefined();
    expect(forbiddenPathReason('.Obsidian./app.json')).toBeDefined();
    expect(forbiddenPathReason('.obsidian ./app.json')).toBeDefined();
  });

  it('allows ordinary vault paths, including lookalikes', () => {
    expect(forbiddenPathReason('Projects/Alpha.md')).toBeUndefined();
    expect(forbiddenPathReason('.gitignore')).toBeUndefined();
    expect(forbiddenPathReason('notes/data.git.md')).toBeUndefined();
  });

  it('refuses Windows alternate-data-stream segments', () => {
    // On NTFS, ':' addresses an alternate data stream, so ".git:payload" still
    // resolves to ".git" on disk and would otherwise slip past the segment check.
    expect(forbiddenPathReason('.git:payload')).toBeDefined();
    expect(forbiddenPathReason('note.md:payload')).toBeDefined();
    expect(forbiddenPathReason('foo/.obsidian:x/bar')).toBeDefined();
    expect(forbiddenPathReason('Some Note.md')).toBeUndefined();
  });
});
