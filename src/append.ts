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
    const trimmed = content.replace(/\n+$/, '');
    return `${trimmed}\n\n## ${wanted}\n\n${text}\n`;
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

  lines.splice(insertAt + 1, 0, ...text.split('\n'));
  return lines.join('\n');
}
