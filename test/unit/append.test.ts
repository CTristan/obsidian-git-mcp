import { describe, expect, it } from 'vitest';
import { appendToSection } from '../../src/append.js';

describe('appendToSection', () => {
  it('recognizes closed ATX headings', () => {
    // "## Log ##" is the same section as "Log"; missing this would create a duplicate.
    const note = '# T\n\n## Log ##\n\n- one\n';
    expect(appendToSection(note, 'Log', '- two')).toBe('# T\n\n## Log ##\n\n- one\n- two\n');
  });

  it('does not treat a trailing # inside a name as a closing marker', () => {
    const note = '# T\n\n## C#\n\n- one\n';
    expect(appendToSection(note, 'C#', '- two')).toBe('# T\n\n## C#\n\n- one\n- two\n');
  });

  it('rejects an empty heading instead of creating an unfindable "## " section', () => {
    const note = '# T\n\n- one\n';
    expect(() => appendToSection(note, '', '- two')).toThrow(/non-empty single line/);
  });

  it('rejects a heading with an embedded newline instead of injecting a second heading', () => {
    const note = '# T\n\n- one\n';
    expect(() => appendToSection(note, 'Foo\n## Injected', '- two')).toThrow(
      /non-empty single line/,
    );
  });
});
