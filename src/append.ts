// The optional trailing group strips a closed-ATX marker ("## Log ##"), which needs
// whitespace before it — a bare trailing # ("## C#") is part of the name.
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE = /^(`{3,}|~{3,})/;

// A fenced code block can contain a line that looks like a heading (e.g. a "## Log"
// line inside a ``` example); both scans below need to ignore those, so this returns,
// per line, whether it sits inside an (unclosed) fence.
//
// Per CommonMark, a fence opened with a run of N backticks (or tildes) is closed only
// by a line whose leading run is the same character and at least N long — a narrower or
// different-character run inside the fence (e.g. a 3-backtick line documenting fence
// syntax inside a 4-backtick fence) must not close it.
function fenceMask(lines: readonly string[]): boolean[] {
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  return lines.map((line) => {
    const wasFenced = inFence;
    const trimmed = line.trim();
    const m = FENCE.exec(trimmed);
    if (m) {
      const marker = m[1]!;
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (
        marker[0] === fenceChar &&
        marker.length >= fenceLen &&
        // A closing fence marker may be followed only by whitespace (CommonMark) — a
        // trailing info string like "``` not-a-close" leaves the fence open.
        trimmed.slice(marker.length).trim() === ''
      ) {
        inFence = false;
      }
    }
    return wasFenced;
  });
}

/**
 * Append text at the end of the named section. The section runs from its heading to the
 * next heading of the same or higher level (or end of note). New text lands after the
 * section's last non-empty line, so trailing blank lines and the following section stay
 * byte-identical. A missing heading creates the section at the end of the note, because
 * the common agent intent ("add this to the Log") shouldn't fail on first use.
 */
export function appendToSection(content: string, heading: string, text: string): string {
  const wanted = heading.trim();
  if (
    wanted === '' ||
    /[\r\n]/.test(wanted) ||
    HEADING.exec(`## ${wanted}`)?.[2] !== wanted
  ) {
    throw new Error('heading must be a non-empty single line');
  }
  // Match the note's existing line-ending style, because splicing LF lines into a CRLF
  // note would leave it mixed.
  const useCRLF = content.includes('\r\n');
  const lines = content.split('\n');
  const fenced = fenceMask(lines);

  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
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
    if (fenced[i]) continue;
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
