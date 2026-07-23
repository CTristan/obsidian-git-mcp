import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createMcpVaultServer, PathFilter } from '@bitbonsai/mcpvault';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

// The wrapper's containment and commit-message code carries per-tool knowledge of which
// MCPVault args hold vault paths: READ_PATH_ARG_KEYS / WRITE_PATH_ARG_KEYS in src/server.ts,
// commitMessageFor's oldPath -> newPath handling for the move tools, and the assumption that
// delete_note/move_file's confirm* args never carry an independent destination. None of that
// is visible to MCPVault, so an upstream rename or addition of a path-carrying arg would
// bypass containment without any test going red. This snapshot pins the full per-tool
// argument surface as the containment layer was written against it; when it fails on an
// upgrade, re-verify those key sets and assumptions against the changed schema before
// updating the entry.
const MCPVAULT_TOOL_ARGS: Record<string, string[]> = {
  delete_note: ['confirmPath', 'path', 'trashMode'],
  get_frontmatter: ['path', 'prettyPrint'],
  get_notes_info: ['paths', 'prettyPrint'],
  get_vault_stats: ['prettyPrint', 'recentCount'],
  list_all_tags: ['prettyPrint'],
  list_directory: ['path', 'prettyPrint'],
  manage_tags: ['operation', 'path', 'tags'],
  move_file: ['confirmNewPath', 'confirmOldPath', 'newPath', 'oldPath', 'overwrite'],
  move_note: ['newPath', 'oldPath', 'overwrite'],
  patch_note: ['newString', 'oldString', 'path', 'replaceAll'],
  read_multiple_notes: ['includeContent', 'includeFrontmatter', 'paths', 'prettyPrint'],
  read_note: ['path', 'prettyPrint'],
  search_notes: [
    'caseSensitive',
    'excludePaths',
    'limit',
    'pathPrefix',
    'prettyPrint',
    'query',
    'searchContent',
    'searchFrontmatter',
  ],
  update_frontmatter: ['frontmatter', 'merge', 'path'],
  write_note: ['content', 'frontmatter', 'mode', 'path'],
};

describe('MCPVault tool argument surface', () => {
  it('matches the per-tool arg names the containment layer was written against', async () => {
    // Same live-runtime binding as the PathFilter assertion above: spin the real MCPVault
    // server over an InMemoryTransport pair (exactly how src/server.ts wires it) and read
    // the schemas it actually serves, so the pin can never drift from what ships.
    const dir = await mkdtemp(join(tmpdir(), 'ogm-arg-drift-'));
    try {
      const inner = createMcpVaultServer(dir, { name: 'arg-drift-probe', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await inner.connect(serverTransport);
      const client = new Client({ name: 'arg-drift-probe-client', version: '0.0.0' });
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const actual = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort(),
        ]),
      );
      await client.close();

      expect(actual).toEqual(MCPVAULT_TOOL_ARGS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
