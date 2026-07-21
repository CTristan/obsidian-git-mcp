import matter from 'gray-matter';

export class ValidationError extends Error {
  override name = 'ValidationError';
}

// Only the unambiguous begin/end markers. A bare ======= line is legal markdown (a
// setext heading underline), so flagging it alone would reject real notes.
const CONFLICT_MARKERS = [/^<{7}( |$)/m, /^>{7}( |$)/m];

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
    matter(content);
  } catch (err) {
    throw new ValidationError(
      `${path}: frontmatter YAML does not parse: ${(err as Error).message}`,
    );
  }
}
