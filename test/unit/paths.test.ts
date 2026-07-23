import { PathFilter } from '@bitbonsai/mcpvault';
import { describe, expect, it } from 'vitest';
import { forbiddenPathReason } from '../../src/paths.js';

describe('forbiddenPathReason', () => {
  it('refuses traversal, absolute paths, and restricted directories', () => {
    expect(forbiddenPathReason('')).toBeDefined();
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

  it('refuses dot-and-space-only segments that Win32 folds to a traversal', () => {
    // Win32 strips a segment's trailing dots and spaces, so ".. " resolves to ".." — a
    // traversal the raw split(/) check misses because ".. " !== "..". A segment made of
    // only dots and spaces is never a legitimate note name, so refuse the whole class.
    expect(forbiddenPathReason('.. /outside.md')).toBeDefined();
    expect(forbiddenPathReason('a/.. /b.md')).toBeDefined();
    expect(forbiddenPathReason('. ./outside.md')).toBeDefined();
  });

  it('refuses a leading-space alias of a restricted directory', () => {
    // The trailing-fold missed a leading space: " .obsidian" shares the restricted
    // target once the space is folded away.
    expect(forbiddenPathReason(' .obsidian/app.json')).toBeDefined();
    expect(forbiddenPathReason(' .git/config')).toBeDefined();
  });

  it('allows ordinary vault paths, including lookalikes', () => {
    expect(forbiddenPathReason('Projects/Alpha.md')).toBeUndefined();
    expect(forbiddenPathReason('.gitignore')).toBeUndefined();
    expect(forbiddenPathReason('notes/data.git.md')).toBeUndefined();
  });

  it('refuses Windows reserved device names regardless of extension', () => {
    // On Windows, CON/PRN/AUX/NUL/COM1-9/LPT1-9 resolve to the device with any extension,
    // so "NUL.md" silently drops the write instead of touching the vault file. Match the
    // segment's base name case-insensitively after the same trailing-dot/space fold.
    expect(forbiddenPathReason('NUL.md')).toBeDefined();
    expect(forbiddenPathReason('con')).toBeDefined();
    expect(forbiddenPathReason('COM1.txt')).toBeDefined();
    expect(forbiddenPathReason('notes/LPT9.md')).toBeDefined();
    // Near-misses that merely start with a device prefix, or fall outside the numeric
    // range, stay allowed — the reservation is exact on the base name.
    expect(forbiddenPathReason('CONSOLE.md')).toBeUndefined();
    expect(forbiddenPathReason('COM10.md')).toBeUndefined();
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

describe('canonicalization drift guard', () => {
  it('refuses every restricted spelling MCPVault folds to a restricted segment', () => {
    // paths.ts mirrors MCPVault's per-segment trailing-dot/space fold as a second
    // defense (paths.ts:40), but that mirror was unguarded — a MCPVault upgrade that
    // widens the fold would silently desync the two layers. canonicalizeForMatch is
    // `private` only at the TypeScript layer; MCPVault compiles to a plain-JS prototype
    // method, so the cast below invokes the real runtime fold PathFilter applies before
    // matching its deny-list. We derive the truth set from MCPVault itself: any spelling
    // it folds back to ".git"/".obsidian" is one MCPVault treats as restricted, so the
    // wrapper's second-defense layer must refuse it too. If a future fold widens and the
    // mirror stays put, the new spellings go red here instead of quietly desyncing.
    const filter = new PathFilter() as unknown as {
      canonicalizeForMatch(path: string): string;
    };
    const restricted = ['.git', '.obsidian'];
    const decorations = ['', '.', ' ', '..', '  ', '. ', ' .', '. .', ' . '];
    for (const name of restricted) {
      for (const lead of decorations) {
        for (const trail of decorations) {
          const segment = `${lead}${name}${trail}`;
          if (filter.canonicalizeForMatch(segment).toLowerCase() !== name) continue;
          expect(forbiddenPathReason(`${segment}/note.md`)).toBeDefined();
        }
      }
    }
  });
});
