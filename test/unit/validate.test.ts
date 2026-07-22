import { describe, expect, it } from 'vitest';
import { validateNoteContent, ValidationError } from '../../src/validate.js';

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
});
