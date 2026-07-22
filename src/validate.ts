import matter from 'gray-matter';

export class ValidationError extends Error {
  override name = 'ValidationError';
}

// Only the unambiguous begin/end markers. A bare ======= line is legal markdown (a
// setext heading underline), so flagging it alone would reject real notes.
const CONFLICT_MARKERS = [/^<{7,}(?:[ \t]|$)/m, /^>{7,}(?:[ \t]|$)/m];

// gray-matter's js/javascript engines evaluate the frontmatter body in-process, so a note
// tagged "---js" is remote code execution the moment it's parsed — and we parse every
// changed file, including ones just fetched from the remote. Disable those engines by
// throwing from them; gray-matter's yaml/json engines stay untouched, and its yaml engine
// uses js-yaml safe-load (the !!js/function tag is rejected, not constructed), so YAML is
// the only executable-frontmatter surface and it's closed. Exact-pinned gray-matter means
// js/javascript are the complete set of code-executing default engines to cover here.
const refuseEngine = (lang: string) => () => {
  throw new Error(`${lang} frontmatter is not allowed`);
};
const SAFE_ENGINES = {
  js: refuseEngine('js'),
  javascript: refuseEngine('javascript'),
};

/**
 * Wrapper-level content validation, run on every file a transaction changed before it
 * is committed. Failing here rolls the whole transaction back.
 */
export function validateNoteContent(path: string, content: string): void {
  if (content.includes('\0')) {
    throw new ValidationError(`${path}: content contains NUL bytes`);
  }
  for (const marker of CONFLICT_MARKERS) {
    if (marker.test(content)) {
      throw new ValidationError(
        `${path}: content contains git conflict markers; resolve them before writing`,
      );
    }
  }
  try {
    // gray-matter caches by content string, but writes the cache entry before parsing
    // completes — a failed parse leaves an empty-data object cached under that string,
    // so a later call with byte-identical malformed content would silently "succeed."
    // Passing an options object (even empty) opts out of that cache entirely.
    matter(content, { engines: SAFE_ENGINES });
  } catch (err) {
    throw new ValidationError(
      `${path}: frontmatter YAML does not parse: ${(err as Error).message}`,
    );
  }
}
