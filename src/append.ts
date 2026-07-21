const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Append text at the end of the named section. The section runs from its heading to the
 * next heading of the same or higher level (or end of note). New text lands after the
 * section's last non-empty line, so trailing blank lines and the following section stay
 * byte-identical. A missing heading creates the section at the end of the note, because
 * the common agent intent ("add this to the Log") shouldn't fail on first use.
 */
export function appendToSection(content: string, heading: string, text: string): string {
  const wanted = heading.trim();
  // Match the note's existing line-ending style, because splicing LF lines into a CRLF
  // note would leave it mixed.
  const useCRLF = content.includes('\r\n');
  const lines = content.split('\n');

  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]!);
    if (m && m[2] === wanted) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }

  if (start === -1) {
    const eol = useCRLF ? '\r\n' : '\n';
    const trimmed = content.replace(/[\r\n]+$/, '');
    const body = text.split('\n').map((l) => l.replace(/\r$/, '')).join(eol);
    return `${trimmed}${eol}${eol}## ${wanted}${eol}${eol}${body}${eol}`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }

  let insertAt = start;
  for (let i = end - 1; i > start; i--) {
    if (lines[i]!.trim() !== '') {
      insertAt = i;
      break;
    }
  }

  const inserted = text.split('\n').map((l) => {
    const bare = l.replace(/\r$/, '');
    return useCRLF ? `${bare}\r` : bare;
  });
  lines.splice(insertAt + 1, 0, ...inserted);
  return lines.join('\n');
}
