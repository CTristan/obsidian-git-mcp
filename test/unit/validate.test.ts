import { describe, expect, it } from 'vitest';
import {
  refuseExecutableFrontmatter,
  validateNoteContent,
  ValidationError,
} from '../../src/validate.js';

describe('validateNoteContent', () => {
  it('rejects content containing a NUL byte', () => {
    expect(() => validateNoteContent('Note.md', 'before\0after')).toThrow(ValidationError);
    expect(() => validateNoteContent('Note.md', 'before\0after')).toThrow(/NUL bytes/);
  });

  it('rejects content containing a begin conflict marker', () => {
    expect(() => validateNoteContent('Note.md', '<<<<<<< HEAD\nours\n')).toThrow(ValidationError);
    expect(() => validateNoteContent('Note.md', '<<<<<<< HEAD\nours\n')).toThrow(
      /conflict markers/,
    );
  });

  it('rejects content containing an end conflict marker', () => {
    expect(() => validateNoteContent('Note.md', 'theirs\n>>>>>>> other\n')).toThrow(
      ValidationError,
    );
    expect(() => validateNoteContent('Note.md', 'theirs\n>>>>>>> other\n')).toThrow(
      /conflict markers/,
    );
  });

  it('rejects a begin conflict marker longer than seven characters', () => {
    expect(() => validateNoteContent('Note.md', '<<<<<<<< HEAD\nours\n')).toThrow(
      ValidationError,
    );
    expect(() => validateNoteContent('Note.md', '<<<<<<<< HEAD\nours\n')).toThrow(
      /conflict markers/,
    );
  });

  it('rejects an end conflict marker longer than seven characters', () => {
    expect(() => validateNoteContent('Note.md', 'theirs\n>>>>>>>> branch-name\n')).toThrow(
      ValidationError,
    );
    expect(() => validateNoteContent('Note.md', 'theirs\n>>>>>>>> branch-name\n')).toThrow(
      /conflict markers/,
    );
  });

  it('does not reject seven marker characters followed by non-whitespace, non-EOL text', () => {
    expect(() => validateNoteContent('Note.md', '<<<<<<<not-a-marker\n')).not.toThrow();
  });

  it('does not reject a bare ======= line, since it is legal setext-heading markdown', () => {
    expect(() =>
      validateNoteContent('Note.md', 'Heading\n=======\n\nBody text.\n'),
    ).not.toThrow();
  });

  it('rejects malformed frontmatter YAML', () => {
    const content = '---\ntitle: [unclosed\n---\nBody\n';
    expect(() => validateNoteContent('Note.md', content)).toThrow(ValidationError);
    expect(() => validateNoteContent('Note.md', content)).toThrow(
      /frontmatter YAML does not parse/,
    );
  });

  it('rejects the same malformed frontmatter on every call, not just the first', () => {
    // Regression: gray-matter caches by content string but writes the cache entry
    // before parsing completes, so a failed parse used to leave an empty-data object
    // cached under that string — a later call with byte-identical content silently
    // passed instead of throwing again.
    const content = '---\ntitle: [unclosed\n---\nBody\n';
    for (let i = 0; i < 3; i++) {
      expect(() => validateNoteContent('Note.md', content)).toThrow(ValidationError);
    }
  });

  it('passes content with valid frontmatter', () => {
    expect(() =>
      validateNoteContent('Note.md', '---\ntitle: test\ntags: [project]\n---\nBody text.\n'),
    ).not.toThrow();
  });

  it('passes plain content with no frontmatter at all', () => {
    expect(() => validateNoteContent('Note.md', 'Just a body, no frontmatter.\n')).not.toThrow();
  });

  it('refuses executable JavaScript frontmatter instead of running it', () => {
    // gray-matter's js/javascript engines evaluate the frontmatter body in-process, so a
    // note carrying `---js` is remote code execution the moment we validate it — and we
    // validate every changed file, including ones fetched from the remote. The engine
    // must be refused, and the payload must never run.
    (globalThis as Record<string, unknown>)['__validateProbe'] = false;
    const payload = [
      '---js',
      'module.exports = { t: ((globalThis.__validateProbe = true), "x") }',
      '---',
      'body',
    ].join('\n');
    expect(() => validateNoteContent('Note.md', payload)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
    // The refusal reports what it is, not a misleading "YAML does not parse".
    expect(() => validateNoteContent('Note.md', payload)).toThrow(/frontmatter is not allowed/);
    // The `javascript` alias reaches the same engine.
    const aliased = payload.replace('---js', '---javascript');
    expect(() => validateNoteContent('Note.md', aliased)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
  });

  it('refuses a mixed-case ---JS frontmatter tag instead of running it', () => {
    // gray-matter lowercases the language tag before looking it up in the caller-supplied
    // `engines` map, so `---JS` still resolves to the refusing engine above — this locks
    // that in against a future gray-matter bump silently reopening a case-variant bypass.
    (globalThis as Record<string, unknown>)['__validateProbe'] = false;
    const payload = [
      '---JS',
      'module.exports = { t: ((globalThis.__validateProbe = true), "x") }',
      '---',
      'body',
    ].join('\n');
    expect(() => validateNoteContent('Note.md', payload)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
  });

  it('refuses a YAML frontmatter that deserializes a js/function tag', () => {
    // Defense-in-depth guard: gray-matter's YAML engine uses js-yaml safe-load, which
    // rejects the !!js/function tag rather than constructing a callable — this locks that
    // in, so a dependency bump that re-enabled unsafe load would fail here.
    const payload = [
      '---',
      'evil: !!js/function >',
      '  function () { return 1; }',
      '---',
      'body',
    ].join('\n');
    expect(() => validateNoteContent('Note.md', payload)).toThrow(ValidationError);
  });
});

describe('refuseExecutableFrontmatter', () => {
  it('refuses executable JavaScript frontmatter on the read path instead of running it', () => {
    // gray-matter merges its default js/javascript engines back in on every read, so a note
    // fetched from the remote carrying `---js` is remote code execution the moment MCPVault
    // parses it. This guard must refuse the engine first, and the payload must never run.
    (globalThis as Record<string, unknown>)['__validateProbe'] = false;
    const payload = [
      '---js',
      'module.exports = { t: ((globalThis.__validateProbe = true), "x") }',
      '---',
      'body',
    ].join('\n');
    expect(() => refuseExecutableFrontmatter('Note.md', payload)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
    // The refusal reports what it is, prefixed with the note path.
    expect(() => refuseExecutableFrontmatter('Note.md', payload)).toThrow(
      /Note\.md: js frontmatter is not allowed/,
    );
    // The `javascript` alias reaches the same refusing engine.
    const aliased = payload.replace('---js', '---javascript');
    expect(() => refuseExecutableFrontmatter('Note.md', aliased)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
  });

  it('refuses a mixed-case ---JS frontmatter tag instead of running it', () => {
    // gray-matter lowercases the language tag before the engine lookup, so `---JS` still
    // resolves to the refusing engine — locking that in against a case-variant bypass.
    (globalThis as Record<string, unknown>)['__validateProbe'] = false;
    const payload = [
      '---JS',
      'module.exports = { t: ((globalThis.__validateProbe = true), "x") }',
      '---',
      'body',
    ].join('\n');
    expect(() => refuseExecutableFrontmatter('Note.md', payload)).toThrow(ValidationError);
    expect((globalThis as Record<string, unknown>)['__validateProbe']).toBe(false);
  });

  it('accepts valid frontmatter', () => {
    expect(() =>
      refuseExecutableFrontmatter('Note.md', '---\ntitle: test\ntags: [project]\n---\nBody text.\n'),
    ).not.toThrow();
  });

  it('accepts plain content with no frontmatter at all', () => {
    expect(() =>
      refuseExecutableFrontmatter('Note.md', 'Just a body, no frontmatter.\n'),
    ).not.toThrow();
  });

  it('leaves a non-engine YAML parse failure alone', () => {
    // Unlike the write path, a malformed-but-not-executable note already on the remote isn't
    // this guard's to reject: it swallows the plain YAML parse error so MCPVault hits the same
    // failure and reports it on its own terms. Only an engine refusal propagates.
    expect(() =>
      refuseExecutableFrontmatter('Note.md', '---\ntitle: [unclosed\n---\nBody\n'),
    ).not.toThrow();
  });
});
