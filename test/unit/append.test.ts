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

  it('keeps a wider fence open across a narrower inner run of the same marker', () => {
    // A 4-backtick fence is closed only by another run of 4+ backticks — a 3-backtick
    // line inside it (e.g. documenting the fence syntax itself) must not close it, so
    // the "## Fake" line it contains stays masked instead of ending the "Log" section.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '````',
      '```',
      '## Fake',
      '````',
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
      '````',
      '```',
      '## Fake',
      '````',
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

  it('does not close a fence on a marker line followed by non-whitespace text', () => {
    // Per CommonMark, a closing fence marker may be followed only by whitespace — a line
    // like "``` not-a-close" doesn't close the fence, so the "## Fake" line after it must
    // stay masked instead of ending the "Log" section early.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '```',
      '``` not-a-close',
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
      '``` not-a-close',
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

  it('does not open a fence on a 4-space-indented marker (indented code, not a fence)', () => {
    // Per CommonMark a fence opener may be indented at most 3 spaces — a line indented 4+
    // is an indented code block, so "    ```" must not open a fence that then masks the
    // real "## Log" heading and forces a duplicate section at the end of the note.
    const note = [
      '# T',
      '',
      '    ```',
      '',
      '## Log',
      '',
      '- one',
      '',
    ].join('\n');
    const expected = [
      '# T',
      '',
      '    ```',
      '',
      '## Log',
      '',
      '- one',
      '- two',
      '',
    ].join('\n');
    expect(appendToSection(note, 'Log', '- two')).toBe(expected);
  });

  it('opens and closes a fence indented 1-3 spaces (inner heading stays masked)', () => {
    // A marker indented 0-3 spaces is still a valid fence, so a 2-space-indented "  ```"
    // opens the fence and its 2-space-indented twin closes it — the "## Fake" between them
    // stays masked instead of ending the "Log" section early.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '  ```',
      '## Fake',
      '  ```',
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
      '  ```',
      '## Fake',
      '  ```',
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

  it('does not open a fence on a tab-indented marker (tab counts as indented code)', () => {
    // A tab is indented code, not the 0-3 leading spaces a fence opener allows, so "\t```"
    // must not open a fence that masks the following "## Log" heading into a duplicate.
    const note = [
      '# T',
      '',
      '\t```',
      '',
      '## Log',
      '',
      '- one',
      '',
    ].join('\n');
    const expected = [
      '# T',
      '',
      '\t```',
      '',
      '## Log',
      '',
      '- one',
      '- two',
      '',
    ].join('\n');
    expect(appendToSection(note, 'Log', '- two')).toBe(expected);
  });

  it('keeps a wider tilde fence open across a narrower inner run of the same marker', () => {
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '~~~~',
      '~~~',
      '## Fake',
      '~~~~',
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
      '~~~~',
      '~~~',
      '## Fake',
      '~~~~',
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
});
