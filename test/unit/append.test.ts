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

  it('treats an empty ATX heading as a section boundary', () => {
    // A bare "##" (no title) is a valid CommonMark heading. Missing it as a boundary
    // means the "Log" section's scan runs past it and appends inside the following,
    // unlabeled section instead of after "Log"'s own last line.
    const note = '## Log\n- one\n##\n- other\n';
    expect(appendToSection(note, 'Log', '- two')).toBe('## Log\n- one\n- two\n##\n- other\n');
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

  it('masks a "##" line inside a fenced code block in a CRLF note', () => {
    // Splitting a CRLF note on "\n" leaves every line with a trailing "\r", so the fence
    // matcher has to tolerate it — otherwise the fence never opens, the inner "## Fake"
    // reads as a real boundary, and the append lands inside the code block. Output stays
    // byte-identical CRLF.
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
    ].join('\r\n');
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
    ].join('\r\n');
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

  it('recognizes an existing heading indented up to three spaces', () => {
    // CommonMark allows an ATX heading indented 0-3 spaces, so it must append into the
    // existing section rather than duplicate it un-indented at the end.
    const note = '# T\n\n  ## Log\n\n- one\n';
    expect(appendToSection(note, 'Log', '- two')).toBe('# T\n\n  ## Log\n\n- one\n- two\n');
  });

  it('treats a four-space-indented heading as code, not a section', () => {
    // 4+ spaces is an indented code block, not a heading — so no "Log" section exists and
    // one is created at the end.
    const note = '# T\n\n    ## Log\n\n- one\n';
    expect(appendToSection(note, 'Log', '- two')).toBe(
      '# T\n\n    ## Log\n\n- one\n\n## Log\n\n- two\n',
    );
  });

  it('does not prepend blank lines when creating a section in an empty note', () => {
    // First-use case: an empty (or whitespace-only) note must start with the new heading,
    // not two blank lines before it.
    expect(appendToSection('', 'Log', '- one')).toBe('## Log\n\n- one\n');
    expect(appendToSection('\n\n', 'Log', '- one')).toBe('## Log\n\n- one\n');
  });

  it('appends after the closing fence when a section ends with a code block', () => {
    // The section's last real line is the closing ``` (a masked line), and inserting
    // after it lands the text OUTSIDE the block. Locking this guards against a fence-skip
    // "fix" to the insert scan that would instead land the append after the opener and
    // swallow it into the code.
    const note = ['# T', '', '## Log', '', '```', 'code', '```', ''].join('\n');
    const expected = ['# T', '', '## Log', '', '```', 'code', '```', '- added', ''].join('\n');
    expect(appendToSection(note, 'Log', '- added')).toBe(expected);
  });

  it('does not swallow the append into a section whose fence never closes', () => {
    // A stored note with an unterminated fence running to end-of-file has no line that is
    // both real and outside the block, so the append goes right after the heading rather
    // than inside the open code block.
    const note = ['# T', '', '## Log', '', '```', 'code line', ''].join('\n');
    const expected = ['# T', '', '## Log', '- added', '', '```', 'code line', ''].join('\n');
    expect(appendToSection(note, 'Log', '- added')).toBe(expected);
  });

  it('appends after real content that precedes a fence that never closes', () => {
    // An unclosed fence only consumes the remainder of the note from its own opener
    // onward — content before the opener (here "- one") is still real prose, so the
    // append must land after it rather than reordered ahead of it at the heading.
    const note = ['# T', '', '## Log', '', '- one', '', '```', 'code line', ''].join('\n');
    const expected = [
      '# T',
      '',
      '## Log',
      '',
      '- one',
      '- added',
      '',
      '```',
      'code line',
      '',
    ].join('\n');
    expect(appendToSection(note, 'Log', '- added')).toBe(expected);
  });

  it('does not open a backtick fence whose info string contains a backtick', () => {
    // Per CommonMark a backtick-fence info string may not contain a backtick, so
    // "```foo`bar" is inline code, not a fence opener. Opening one here would mask the
    // real "## Log" heading below and force a duplicate section at the end of the note.
    const note = ['# T', '', '```foo`bar', '', '## Log', '', '- one', ''].join('\n');
    const expected = ['# T', '', '```foo`bar', '', '## Log', '', '- one', '- two', ''].join('\n');
    expect(appendToSection(note, 'Log', '- two')).toBe(expected);
  });

  it('opens a backtick fence whose info string is a bare language tag', () => {
    // A backtick-fence info string without a backtick (a language tag like "js") is a
    // valid opener — the restriction is on backticks, not on non-empty info strings — so
    // the "## Fake" line inside must stay masked instead of ending the "Log" section.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '```js',
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
      '```js',
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

  it('opens a tilde fence whose info string contains a backtick', () => {
    // The backtick-in-info-string restriction is asymmetric: only backtick fences carry
    // it, so a tilde fence like "~~~foo`bar" still opens normally and the "## Fake" line
    // it wraps stays masked. Guards against a fix that over-restricts tilde fences too.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '~~~foo`bar',
      '## Fake',
      '~~~',
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
      '~~~foo`bar',
      '## Fake',
      '~~~',
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

  it('does not close a fence when the marker line trailing text contains backticks', () => {
    // A closing fence may be followed only by whitespace, so "``` `not`close" — trailing
    // text that itself contains backticks — does not close the fence. The "## Fake" line
    // after it stays masked instead of ending the "Log" section early.
    const note = [
      '# T',
      '',
      '## Log',
      '',
      '```',
      '``` `not`close',
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
      '``` `not`close',
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

  it('refuses to create a missing section when the note ends inside an unclosed fence', () => {
    // The document ends inside a fence that never closes, so a new "## Log" heading (and
    // its appended text) would land as code-block content and silently corrupt the note.
    // Refuse instead of appending into the open fence.
    const note = ['# T', '', '## Notes', '', '```', 'code line', ''].join('\n');
    expect(() => appendToSection(note, 'Log', '- added')).toThrow(/unclosed code fence/);
  });

  it('refuses a missing-section append when a CRLF note ends inside an unclosed fence', () => {
    // Same refusal as the LF case, but the "```" opener carries a trailing "\r" — the fence
    // matcher must see through it, or endsOpen never trips and the refusal silently degrades
    // into creating the section inside the still-open code block.
    const note = ['# T', '', '## Notes', '', '```', 'code line', ''].join('\r\n');
    expect(() => appendToSection(note, 'Log', '- added')).toThrow(/unclosed code fence/);
  });

  it('still creates a missing section when the note fences are all closed', () => {
    // The unclosed-fence refusal must not fire when the fence closes — the note has no
    // "Log" section but its code block is terminated, so the section is created at the end.
    const note = ['# T', '', '## Notes', '', '```', 'code line', '```', ''].join('\n');
    expect(appendToSection(note, 'Log', '- added')).toBe(`${note}\n## Log\n\n- added\n`);
  });
});
