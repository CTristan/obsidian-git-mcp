import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, startServer, textOf, type TestServer } from '../helpers.js';

describe('security', () => {
  let fx: Fixture;
  let srv: TestServer;

  beforeEach(async () => {
    fx = await createFixture();
    srv = await startServer(fx);
  });

  afterEach(async () => {
    await srv.close();
    await fx.cleanup();
  });

  it('path traversal is refused for reads', async () => {
    await writeFile(join(fx.root, 'outside.md'), 'secret outside the vault\n');
    const res = await callTool(srv.client, 'read_note', { path: '../outside.md' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('secret outside the vault');
  });

  it('path traversal is refused for writes', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'write_note', {
      path: '../evil.md',
      content: 'escape attempt\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(join(fx.root, 'evil.md'))).toBe(false);
    const postRemote = await fx.bareHead();
    expect(postRemote).toBe(preRemote);
  });

  it('absolute paths are refused for reads and writes', async () => {
    const read = await callTool(srv.client, 'read_note', { path: '/etc/hosts' });
    expect(read.isError).toBe(true);

    const preRemote = await fx.bareHead();
    const write = await callTool(srv.client, 'write_note', {
      path: '/tmp/evil.md',
      content: 'escape attempt\n',
    });
    expect(write.isError).toBe(true);

    const driveForm = await callTool(srv.client, 'write_note', {
      path: 'C:\\evil.md',
      content: 'escape attempt\n',
    });
    expect(driveForm.isError).toBe(true);
    expect(await fx.bareHead()).toBe(preRemote);
  });

  it('.obsidian writes are refused at the tool layer', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'write_note', {
      path: '.obsidian/app.json',
      content: '{"pwned":true}',
    });
    expect(res.isError).toBe(true);
    const postRemote = await fx.bareHead();
    expect(postRemote).toBe(preRemote);
  });

  it('.obsidian is refused by wrapper-added tools too', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'append_to_section', {
      path: '.obsidian/note.md',
      heading: 'X',
      text: 'y',
    });
    expect(res.isError).toBe(true);
    const postRemote = await fx.bareHead();
    expect(postRemote).toBe(preRemote);
  });

  it('append_to_section refuses a symlink that escapes the vault', async () => {
    // A committed symlink is legitimate vault content, but following it would write
    // outside the checkout — invisibly to git status, so no commit and no rollback
    // would ever cover the damage.
    const target = join(fx.root, 'outside-target.md');
    await writeFile(target, '# Outside\n\n## X\n\noriginal\n');
    await symlink('../outside-target.md', join(fx.collabDir, 'Linked.md'));
    await git(['add', '-A'], fx.collabDir);
    await git(['commit', '-m', 'collab: add symlink'], fx.collabDir);
    await git(['push', 'origin', 'main'], fx.collabDir);

    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Linked.md',
      heading: 'X',
      text: 'injected',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).not.toContain('injected');
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('list_directory omits .obsidian', async () => {
    const res = await callTool(srv.client, 'list_directory', { path: '' });
    expect(textOf(res)).not.toContain('.obsidian');
  });
});
