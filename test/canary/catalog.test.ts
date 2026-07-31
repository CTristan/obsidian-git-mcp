import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanaryCatalog, type CanaryCatalogEntry } from '../../src/canary/catalog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { rm } = await import('node:fs/promises');
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vault-canary-catalog-'));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  await writeFile(
    join(root, 'README.md'),
    '# Main guide\n\nSafety depends on canonical vault transactions.\n',
  );
  await writeFile(join(root, 'docs', 'safety.md'), '# Safety\n\nNo blind retries.\n');
  const entries: CanaryCatalogEntry[] = [
    { id: 'main-guide', path: 'README.md', title: 'Main guide' },
    { id: 'safety', path: 'docs/safety.md', title: 'Safety' },
  ];
  return { entries, root };
}

describe('createCanaryCatalog', () => {
  it('loads only manifest paths and gives every document a canonical URL', async () => {
    const { entries, root } = await fixture();
    const catalog = await createCanaryCatalog({
      baseUrl: 'https://vault-poc.example.com',
      entries,
      root,
    });

    expect(catalog.documents()).toEqual([
      expect.objectContaining({
        id: 'main-guide',
        text: '# Main guide\n\nSafety depends on canonical vault transactions.\n',
        url: 'https://vault-poc.example.com/notes/main-guide',
      }),
      expect.objectContaining({
        id: 'safety',
        url: 'https://vault-poc.example.com/notes/safety',
      }),
    ]);
  });

  it('ranks exact title matches before body-only matches deterministically', async () => {
    const { entries, root } = await fixture();
    const catalog = await createCanaryCatalog({ baseUrl: 'https://example.com', entries, root });

    expect(catalog.search('safety retries').map((result) => result.id)).toEqual([
      'safety',
      'main-guide',
    ]);
    expect(catalog.search('no-match')).toEqual([]);
  });

  it('rejects manifest traversal before reading outside the corpus', async () => {
    const { root } = await fixture();

    await expect(
      createCanaryCatalog({
        baseUrl: 'https://example.com',
        entries: [{ id: 'escape', path: '../secret.md', title: 'Escape' }],
        root,
      }),
    ).rejects.toThrow(/contained relative path/);
  });
});
