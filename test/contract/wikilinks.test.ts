import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../fixture.js';
import {
  callTool,
  commitSymlink,
  headShaOf,
  startServer,
  textOf,
  type TestServer,
} from '../helpers.js';

describe('wikilink read tools', () => {
  let fx: Fixture;
  let srv: TestServer;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.collabWrite(
      'Projects/Source.md',
      '# Source\n\n[[Alpha#Status|project status]]\n',
      'seed: add backlink source',
    );
    srv = await startServer(fx);
  });

  afterEach(async () => {
    await srv.close();
    await fx.cleanup();
  });

  it('lists the wrapper-native tools with their public schemas', async () => {
    const { tools } = await srv.client.listTools();
    const resolveTool = tools.find((tool) => tool.name === 'resolve_wikilink');
    const backlinksTool = tools.find((tool) => tool.name === 'get_backlinks');

    expect(resolveTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['link'],
      properties: {
        link: { type: 'string' },
        sourcePath: { type: 'string' },
      },
    });
    expect(backlinksTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    });
  });

  it('resolves a validated heading and returns the read HEAD SHA', async () => {
    await fx.collabWrite(
      'Archive/Alpha.md',
      '# Alpha duplicate\n',
      'seed: add competing Alpha',
    );

    const res = await callTool(srv.client, 'resolve_wikilink', {
      link: '[[Alpha#Status|project status]]',
      sourcePath: 'Projects/Source.md',
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      path: 'Projects/Alpha.md',
      subpath: { type: 'heading', value: 'Status' },
      alias: 'project status',
    });
    expect(headShaOf(res)).not.toBe('');

    const sameNote = await callTool(srv.client, 'resolve_wikilink', {
      link: '[[#Source]]',
      sourcePath: 'Projects/Source.md',
    });
    expect(sameNote.isError, textOf(sameNote)).toBeFalsy();
    expect(JSON.parse(textOf(sameNote))).toEqual({
      path: 'Projects/Source.md',
      subpath: { type: 'heading', value: 'Source' },
      alias: null,
    });
  });

  it('returns sorted, deduplicated backlinks', async () => {
    await fx.collabWrite(
      'Inbox/Other.md',
      '[[Projects/Alpha]] and ![[Projects/Alpha#Missing]]\n',
      'seed: add second backlink',
    );

    const res = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      path: 'Projects/Alpha.md',
      backlinks: ['Inbox/Other.md', 'Projects/Source.md'],
    });
    expect(headShaOf(res)).not.toBe('');
  });

  it('refreshes the cached index after a collaborator advances HEAD', async () => {
    const first = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(JSON.parse(textOf(first)).backlinks).toEqual(['Projects/Source.md']);
    const firstHead = headShaOf(first);

    await fx.collabWrite(
      'Inbox/Fresh.md',
      'A newly pushed [[Projects/Alpha]] link.\n',
      'collab: add fresh backlink',
    );

    const second = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(JSON.parse(textOf(second)).backlinks).toEqual([
      'Inbox/Fresh.md',
      'Projects/Source.md',
    ]);
    expect(headShaOf(second)).not.toBe(firstHead);
  });

  it('bypasses the clean-HEAD cache when the checkout becomes dirty', async () => {
    const first = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(JSON.parse(textOf(first)).backlinks).toEqual(['Projects/Source.md']);

    await writeFile(
      join(fx.serverDir, 'Projects/Source.md'),
      '# Source\n\nThe tracked note is now locally dirty without a backlink.\n',
    );

    const second = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(JSON.parse(textOf(second)).backlinks).toEqual([]);
    expect(headShaOf(second)).toBe(headShaOf(first));
  });

  it('skips a tracked note deleted from the working tree', async () => {
    await unlink(join(fx.serverDir, 'Projects/Source.md'));

    const res = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      path: 'Projects/Alpha.md',
      backlinks: [],
    });
  });

  it('keeps gitignored Markdown outside the canonical backlink index', async () => {
    await fx.collabWrite('.gitignore', 'Ignored/\n', 'seed: ignore local notes');
    const first = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(first.isError, textOf(first)).toBeFalsy();

    await mkdir(join(fx.serverDir, 'Ignored'));
    await writeFile(join(fx.serverDir, 'Ignored/Local.md'), '[[Projects/Alpha]]\n');

    const second = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(JSON.parse(textOf(second)).backlinks).toEqual(['Projects/Source.md']);
    expect(headShaOf(second)).toBe(headShaOf(first));
  });

  it('reports ambiguous and broken complete links as errors', async () => {
    await fx.collabWrite('Archive/Alpha.md', '# Alpha duplicate\n', 'seed: add duplicate Alpha');

    const ambiguous = await callTool(srv.client, 'resolve_wikilink', {
      link: '[[Alpha]]',
    });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toMatch(/ambiguous/i);

    const brokenHeading = await callTool(srv.client, 'resolve_wikilink', {
      link: '[[Projects/Alpha#Missing]]',
    });
    expect(brokenHeading.isError).toBe(true);
    expect(textOf(brokenHeading)).toMatch(/heading.*Missing.*not found/i);
  });

  it('applies the wrapper path restrictions to both tools', async () => {
    const backlinks = await callTool(srv.client, 'get_backlinks', { path: '../Alpha.md' });
    expect(backlinks.isError).toBe(true);
    expect(textOf(backlinks)).toMatch(/traversal/i);

    const resolve = await callTool(srv.client, 'resolve_wikilink', {
      link: '[[.git/config]]',
    });
    expect(resolve.isError).toBe(true);
    expect(textOf(resolve)).toMatch(/not allowed/i);
  });

  it('refuses an indexed note symlink that resolves into repository internals', async () => {
    await commitSymlink(fx, 'Linked.md', '.git/config', 'collab: add malicious read symlink');

    const res = await callTool(srv.client, 'get_backlinks', {
      path: 'Projects/Alpha.md',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\.git.*not allowed/i);
  });
});
