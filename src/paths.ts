import { isAbsolute, normalize } from 'node:path';

// Second defense layer under MCPVault's PathFilter: the wrapper re-checks every path it
// touches itself (append_to_section) and every path a transaction actually changed,
// because trusting a single layer means one bypass loses the vault.
const RESTRICTED_SEGMENTS = new Set(['.obsidian', '.git']);

/** Returns a human-readable refusal reason, or undefined when the path is acceptable. */
export function forbiddenPathReason(path: string): string | undefined {
  if (path === '') return 'empty path';
  if (isAbsolute(path)) return 'absolute paths are not allowed';
  // Check the raw segments before normalize(), because normalize collapses interior
  // '..' ("notes/../draft.md" -> "draft.md") and the contract is that '..' never
  // appears in an accepted path at all.
  if (path.replaceAll('\\', '/').split('/').includes('..')) {
    return 'path traversal is not allowed';
  }
  const segments = normalize(path).replaceAll('\\', '/').split('/');
  if (segments.includes('..')) return 'path traversal is not allowed';
  for (const segment of segments) {
    // Win32 strips trailing dots and spaces from path segments, so ".git." and ".git "
    // resolve to ".git" on disk; fold those aliases before matching (mirrors MCPVault's
    // canonicalization).
    const folded = segment.replace(/[. ]+$/, '');
    if (RESTRICTED_SEGMENTS.has(folded.toLowerCase())) {
      return `paths under ${segment} are not allowed`;
    }
  }
  return undefined;
}
