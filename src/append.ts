// The title group is optional so a bare "##" — a valid, title-less ATX heading per
// CommonMark — still matches as a heading/boundary; callers normalize a missing capture
// to '' rather than treating the line as non-heading text. The optional trailing group
// strips a closed-ATX marker ("## Log ##"), which needs whitespace before it — a bare
// trailing # ("## C#") is part of the name. The leading " {0,3}" mirrors FENCE:
// CommonMark allows an ATX heading indented 0-3 spaces, while 4+ is indented code —
// matching that here keeps an indented existing heading from being missed and silently
// duplicated.
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.+?))?(?:\s+#+)?\s*$/;
// A fence marker may be indented 0-3 spaces per CommonMark; 4+ spaces (or any leading
// tab) is an indented code block, not a fence, so we match the raw line and cap the
// leading run at three spaces rather than trimming — trimming would let "    ```" or a
// tab-indented "\t```" wrongly open a fence and mask every later real heading. The
// trailing capture is the rest of the line after the marker run: for an opener it's the
// info string (a backtick in a backtick-fence info string voids the opener), and for a
// closer it must be whitespace-only. Splitting a CRLF note on "\n" leaves a trailing "\r" on
// every line, so the capture is "[^\r]*" and a lone "\r?" is consumed before "$" — otherwise
// "." never matches the "\r", "$" (no `m` flag) never reaches it, and the fence fails to
// match at all. Keeping the "\r" out of the captured suffix means it can't flip the
// backtick-info-string opener check or the whitespace-only closer check either.
const FENCE = /^ {0,3}((?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})([^\r]*)\r?$/;

// A fenced code block can contain a line that looks like a heading (e.g. a "## Log"
// line inside a ``` example); both scans below need to ignore those, so this returns,
// per line, whether it sits inside an (unclosed) fence.
//
// Per CommonMark, a fence opened with a run of N backticks (or tildes) is closed only
// by a line whose leading run is the same character and at least N long — a narrower or
// different-character run inside the fence (e.g. a 3-backtick line documenting fence
// syntax inside a 4-backtick fence) must not close it.
function fenceMask(
  lines: readonly string[],
): { mask: boolean[]; endsOpen: boolean; openFenceAt: number } {
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let openFenceAt = -1;
  const mask = lines.map((line, i) => {
    // Capture inFence BEFORE this line toggles it, which deliberately leaves the opening
    // delimiter unmasked (it wasn't inside a fence yet) but the closing delimiter masked
    // (it still was). The insert scan relies on that asymmetry — it appends after the
    // closing delimiter, which lands outside the block — so don't "fix" it to be symmetric.
    const wasFenced = inFence;
    const m = FENCE.exec(line);
    if (m) {
      const listPrefix = m[1]!;
      const marker = m[2]!;
      const suffix = m[3]!;
      if (!inFence) {
        // A backtick fence whose info string contains a backtick is not a valid opener
        // per CommonMark — otherwise inline code like "```foo`bar`" would masquerade as
        // a fence and mask every real heading below it. Tilde fences carry no such
        // restriction, so their info string may hold backticks.
        if (marker[0] !== '`' || !suffix.includes('`')) {
          inFence = true;
          fenceChar = marker[0]!;
          fenceLen = marker.length;
          openFenceAt = i;
        }
      } else if (
        listPrefix === '' &&
        marker[0] === fenceChar &&
        marker.length >= fenceLen &&
        // A closing fence marker may be followed only by whitespace (CommonMark) — a
        // trailing info string like "``` not-a-close" leaves the fence open.
        suffix.trim() === ''
      ) {
        inFence = false;
      }
    }
    return wasFenced;
  });
  // endsOpen reports whether the note finishes inside an unclosed fence — the signal the
  // insert scan needs to avoid dropping an append into a code block that never terminates.
  // openFenceAt is that fence's opening line (meaningful only when endsOpen is true) — an
  // unclosed fence consumes only the remainder of the note from its opener onward, so the
  // insert scan still needs to look for real content before that point.
  return { mask, endsOpen: inFence, openFenceAt };
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
  if (text === '') {
    throw new Error('text must be non-empty');
  }
  if (
    wanted === '' ||
    /[\r\n]/.test(wanted) ||
    (HEADING.exec(`## ${wanted}`)?.[2] ?? '') !== wanted
  ) {
    throw new Error('heading must be a non-empty single line');
  }
  // Match the note's existing line-ending style, because splicing LF lines into a CRLF
  // note would leave it mixed.
  const useCRLF = content.includes('\r\n');
  const lines = content.split('\n');
  const { mask: fenced, endsOpen, openFenceAt } = fenceMask(lines);

  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = HEADING.exec(lines[i]!);
    if (m && (m[2] ?? '') === wanted) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }

  if (start === -1) {
    if (endsOpen) {
      // The note ends inside a fence that never closes, so appending a new heading here
      // would splice it (and its text) into code-block content and silently corrupt the
      // note. Refuse rather than write structure that renders as code.
      throw new Error(
        'refusing to create a new section — the note ends inside an unclosed code fence, so the heading would become code-block content',
      );
    }
    const eol = useCRLF ? '\r\n' : '\n';
    const isBlank = content.trim() === '';
    const hasBlankSeparator = /(?:\r?\n){2,}$/.test(content);
    const trimmed = content.replace(/[\r\n]+$/, '');
    const body = text.split('\n').map((l) => l.replace(/\r$/, '')).join(eol);
    // Skip the leading blank separator when the note is empty (or only newlines), so a
    // brand-new note starts with the heading rather than two blank lines before it. When
    // the note already has a blank separator, preserve every existing trailing blank line.
    const prefix = isBlank ? '' : hasBlankSeparator ? content : `${trimmed}${eol}${eol}`;
    return `${prefix}## ${wanted}${eol}${eol}${body}${eol}`;
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
  // When the section runs to end-of-file inside a fence that never closes, only the lines
  // from that fence's opener onward are code-block content — an unclosed CommonMark fence
  // consumes just the remainder after its opener, not anything before it. Bound the scan
  // there instead of at `end` so real content preceding the fence (e.g. a list) is still
  // found; falling back to the heading (the initial `insertAt`) when nothing precedes the
  // opener. A closed fence doesn't hit this — its closing delimiter is a real line the
  // unbounded scan correctly appends after.
  const scanFrom = end === lines.length && endsOpen ? openFenceAt - 1 : end - 1;
  for (let i = scanFrom; i > start; i--) {
    if (lines[i]!.trim() !== '') {
      insertAt = i;
      break;
    }
  }

  // Inserting past the array's last element means the note had no trailing newline (a note
  // that ends with one splits to a trailing "" element the scan lands before), so the last
  // inserted line becomes the note's new final line with no "\n" after it.
  const atEnd = insertAt + 1 === lines.length;
  const bareLines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const inserted = bareLines.map((bare, i) => {
    // A CRLF line carries its "\r" only because the join supplies a following "\n"; the new
    // final line of a no-trailing-newline note has none, so a "\r" there would dangle alone.
    const isNewFinalLine = atEnd && i === bareLines.length - 1;
    return useCRLF && !isNewFinalLine ? `${bare}\r` : bare;
  });
  if (useCRLF && atEnd && !lines[insertAt]!.endsWith('\r')) {
    // The displaced former-last line never got a "\r" (the note ended without a newline), but
    // the splice pushes it before a join "\n", so restore its CRLF pair to keep endings uniform.
    lines[insertAt] = `${lines[insertAt]!}\r`;
  }
  lines.splice(insertAt + 1, 0, ...inserted);
  return lines.join('\n');
}
