import { isAbsolute, normalize } from 'node:path';

// Second defense layer under MCPVault's PathFilter: the wrapper re-checks every path it
// touches itself (append_to_section) and every path a transaction actually changed,
// because trusting a single layer means one bypass loses the vault.
const RESTRICTED_SEGMENTS = new Set(['.obsidian', '.git']);

/** Returns a human-readable refusal reason, or undefined when the path is acceptable. */
export function forbiddenPathReason(path: string): string | undefined {
  if (path === '') return 'empty path';
  if (isAbsolute(path)) return 'absolute paths are not allowed';
  const segments = normalize(path).replaceAll('\\', '/').split('/');
  if (segments.includes('..')) return 'path traversal is not allowed';
  for (const segment of segments) {
    if (RESTRICTED_SEGMENTS.has(segment.toLowerCase())) {
      return `paths under ${segment} are not allowed`;
    }
  }
  return undefined;
}
