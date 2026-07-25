import { isAbsolute, normalize } from 'node:path/posix';

// Second defense layer under MCPVault's PathFilter: the wrapper re-checks every path it
// touches itself (append_to_section) and every path a transaction actually changed,
// because trusting a single layer means one bypass loses the vault.
const RESTRICTED_SEGMENTS = new Set(['.obsidian', '.git']);

// Windows reserves CON, PRN, AUX, NUL, COM1-COM9, and LPT1-LPT9 as device names with any
// extension, so "NUL.md" still resolves to the device and the write silently drops instead
// of touching the vault file. The reservation is on the base name (the part before the
// first dot), matched case-insensitively after the same trailing-dot/space fold.
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Returns a human-readable refusal reason, or undefined when the path is acceptable. */
export function forbiddenPathReason(path: string): string | undefined {
  if (path === '') return 'empty path';
  const slashed = path.replaceAll('\\', '/');
  // isAbsolute() on posix misses Windows forms: drive-relative ("C:note.md"),
  // drive-absolute ("C:/x"), and root-relative ("\x" — already folded to "/x").
  if (isAbsolute(path) || /^[A-Za-z]:/.test(slashed) || slashed.startsWith('/')) {
    return 'absolute paths are not allowed';
  }
  // Check the raw segments before normalize(), because normalize collapses interior
  // '..' ("notes/../draft.md" -> "draft.md") and the contract is that '..' never
  // appears in an accepted path at all.
  if (slashed.split('/').includes('..')) {
    return 'path traversal is not allowed';
  }
  if (slashed.startsWith('-')) {
    return 'paths starting with "-" are not allowed';
  }
  const segments = normalize(path).replaceAll('\\', '/').split('/');
  if (segments.includes('..')) return 'path traversal is not allowed';
  for (const segment of segments) {
    // A segment of nothing but dots and spaces (".. ", ". .") is never a real note name,
    // and Win32's trailing-strip folds it to "." or "..", so ".. /x" would resolve to a
    // parent-directory escape the raw ".." check above can't see. Refuse the whole class.
    if (/^[. ]+$/.test(segment)) {
      return 'path traversal is not allowed';
    }
    // On NTFS, ':' addresses an alternate data stream, so "note.md:payload" or
    // ".git:payload" still resolve to the base file/directory on disk.
    if (segment.includes(':')) {
      return 'alternate data streams are not allowed';
    }
    // Win32 strips a segment's trailing dots and spaces and ignores leading spaces, so
    // ".git.", ".git ", and " .git" all resolve to ".git" on disk; fold both edges before
    // matching (mirrors MCPVault's canonicalization).
    const folded = segment.replace(/^ +/, '').replace(/[. ]+$/, '');
    if (RESTRICTED_SEGMENTS.has(folded.toLowerCase())) {
      return `paths under ${segment} are not allowed`;
    }
    if (RESERVED_DEVICE_NAME.test(folded)) {
      return 'Windows reserved device names are not allowed';
    }
  }
  return undefined;
}
