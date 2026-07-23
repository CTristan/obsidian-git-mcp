import { PathFilter } from '@bitbonsai/mcpvault';
import { describe, expect, it } from 'vitest';
import { FRONTMATTER_PARSED_EXTENSIONS } from '../../src/server.js';

describe('FRONTMATTER_PARSED_EXTENSIONS', () => {
  it('is a superset of MCPVault PathFilter.allowedExtensions', () => {
    // allowedExtensions is `private` only at the TypeScript layer -- MCPVault compiles to
    // plain JS fields, so the cast below reads the real runtime array PathFilter's
    // constructor builds. `new PathFilter()` (no config) is exactly what createServer()
    // instantiates when its caller omits a `pathFilter` override, which src/server.ts does
    // at both its createServer() call sites. If a future MCPVault upgrade widens this array,
    // FRONTMATTER_PARSED_EXTENSIONS must widen with it or gray-matter's live js/javascript
    // frontmatter engines run unchecked on the new extension -- this assertion is the guard
    // that turns that drift red instead of silent.
    const { allowedExtensions } = new PathFilter() as unknown as { allowedExtensions: string[] };

    for (const ext of allowedExtensions) {
      expect(FRONTMATTER_PARSED_EXTENSIONS).toContain(ext);
    }
  });
});
