import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createMcpVaultServer, PathFilter } from '@bitbonsai/mcpvault';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FRONTMATTER_PARSED_EXTENSIONS, VERSION } from '../../src/server.js';

describe('VERSION', () => {
  it('matches the package.json version so a bump can never drift', async () => {
    // Read package.json through an independent path from the one server.ts uses, so this
    // stays a real drift guard: if someone re-hardcodes the literal or breaks the lookup,
    // the next `pnpm version` bump turns this red instead of shipping a stale version string.
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('FRONTMATTER_PARSED_EXTENSIONS', () => {
  it('is a superset of MCPVault PathFilter.allowedExtensions', () => {
    // allowedExtensions is `private` only at the TypeScript layer — MCPVault compiles to
    // plain JS fields, so the cast below reads the real runtime array PathFilter's
    // constructor builds. `new PathFilter()` (no config) is exactly what createServer()
    // instantiates when its caller omits a `pathFilter` override, which src/server.ts does
    // at both its createServer() call sites. If a future MCPVault upgrade widens this array,
    // FRONTMATTER_PARSED_EXTENSIONS must widen with it or gray-matter's live js/javascript
    // frontmatter engines run unchecked on the new extension — this assertion is the guard
    // that turns that drift red instead of silent.
    const { allowedExtensions } = new PathFilter() as unknown as { allowedExtensions: string[] };

    for (const ext of allowedExtensions) {
      expect(FRONTMATTER_PARSED_EXTENSIONS).toContain(ext);
    }
  });
});

describe('gray-matter single resolution', () => {
  it('resolves to exactly one version, matching the pin the ---js gate is written against', async () => {
    // src/validate.ts disables gray-matter's js/javascript engines, but that only closes the
    // RCE if MCPVault parses notes with the SAME gray-matter instance — MCPVault declares it
    // as ^4.0.3, so without a single forced resolution a future 4.x could dedupe into a second
    // instance whose default engines run frontmatter the wrapper's copy never sees. The
    // pnpm.overrides pin plus this assertion are what keep that single instance from drifting:
    // if a dependency bump pulls in a second gray-matter version, or the override is dropped,
    // this goes red instead of silently reopening the hole.
    const root = new URL('../../', import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8');

    const pin = pkg.dependencies['gray-matter'];
    expect(pkg.pnpm?.overrides?.['gray-matter']).toBe(pin);

    // Package/snapshot declaration keys sit at two-space indent as `gray-matter@<version>:`;
    // nested `gray-matter: <version>` dependency references are deeper-indented and lack the
    // `@`, so this matches only the resolved-version declarations.
    const versions = new Set(
      [...lockfile.matchAll(/^ {2}gray-matter@([^\s:(]+)/gm)].map((m) => m[1]),
    );
    expect([...versions]).toEqual([pin]);
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
    const inner = createMcpVaultServer(dir, { name: 'arg-drift-probe', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'arg-drift-probe-client', version: '0.0.0' });
    try {
      await inner.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const actual = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort(),
        ]),
      );
      expect(actual).toEqual(MCPVAULT_TOOL_ARGS);
    } finally {
      await Promise.allSettled([client.close(), inner.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
