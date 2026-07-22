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

  it('rejects a heading that would not round-trip through closed-ATX parsing', () => {
    // "Log ##" would render as "## Log ##", which HEADING re-parses back to "Log" —
    // a later append with the same string would then create a duplicate section.
    const note = '# T\n\n- one\n';
    expect(() => appendToSection(note, 'Log ##', '- two')).toThrow(/non-empty single line/);
  });

  it('still accepts a trailing # inside a name that round-trips', () => {
    const note = '# T\n\n## C#\n\n- one\n';
    expect(appendToSection(note, 'C#', '- two')).toBe('# T\n\n## C#\n\n- one\n- two\n');
  });

  it('does not treat a "##" line inside a fenced code block as a section boundary', () => {
    // The fenced "## Fake" line must not end the real "Log" section early, and the
    // appended text must land after the section's actual last line ("- one").
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '```',
      '## Fake',
      '```',
      '',
      '- one',
      '',
      '## Next',
      '',
      '- stuff',
      '',
    ].join('\n');
    const expected = [
      '# T',
      '',
      '## Log',
      '',
      '```',
      '## Fake',
      '```',
      '',
      '- one',
      '- two',
      '',
      '## Next',
      '',
      '- stuff',
      '',
    ].join('\n');
    expect(appendToSection(note, 'Log', '- two')).toBe(expected);
  });

  it('does not select a "##" line inside a fenced code block as the target section', () => {
    // The note has no real "Log" heading, only a fenced example that looks like one, so
    // this must fall through to creating the section at the end of the note.
    const note = [
      '# T',
      '',
      '## Notes',
      '',
      '```',
      '## Log',
      '```',
      '',
      '- note one',
      '',
    ].join('\n');
    expect(appendToSection(note, 'Log', '- started')).toBe(`${note}\n## Log\n\n- started\n`);
  });
});
