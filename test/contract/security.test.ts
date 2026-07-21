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
    const outsideTarget = join(fx.outsideDir, 'evil.md');
    const write = await callTool(srv.client, 'write_note', {
      path: outsideTarget,
      content: 'escape attempt\n',
    });
    expect(write.isError).toBe(true);
    expect(existsSync(outsideTarget)).toBe(false);

    const driveForm = await callTool(srv.client, 'write_note', {
      path: 'C:\\evil.md',
      content: 'escape attempt\n',
    });
    expect(driveForm.isError).toBe(true);
    expect(await fx.bareHead()).toBe(preRemote);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('.obsidian writes are refused at the tool layer', async () => {
    const preRemote = await fx.bareHead();
    const before = await readFile(join(fx.serverDir, '.obsidian', 'app.json'), 'utf8');
    const res = await callTool(srv.client, 'write_note', {
      path: '.obsidian/app.json',
      content: '{"pwned":true}',
    });
    expect(res.isError).toBe(true);
    expect(await fx.bareHead()).toBe(preRemote);
    expect(await readFile(join(fx.serverDir, '.obsidian', 'app.json'), 'utf8')).toBe(before);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('.obsidian is refused by wrapper-added tools too', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'append_to_section', {
      path: '.obsidian/note.md',
      heading: 'X',
      text: 'y',
    });
    expect(res.isError).toBe(true);
    expect(await fx.bareHead()).toBe(preRemote);
    expect(existsSync(join(fx.serverDir, '.obsidian', 'note.md'))).toBe(false);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
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

  it('write_note is refused when a committed symlink resolves into .git', async () => {
    // MCPVault's own filter judges only the literal argument ("Linked.md" — nothing
    // restricted in that string); the target it resolves to is where a segment guard has
    // to catch it. git status never reports .git/ at all, ignored or not, so the
    // transaction layer's changedPaths() scan can never see this write either — closing
    // this hole requires an independent realpath check on the forwarded path itself.
    await symlink('.git/hooks/pre-commit', join(fx.collabDir, 'Linked.md'));
    await git(['add', '-A'], fx.collabDir);
    await git(['commit', '-m', 'collab: add malicious symlink'], fx.collabDir);
    await git(['push', 'origin', 'main'], fx.collabDir);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Linked.md',
      content: '#!/bin/sh\necho pwned\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(join(fx.serverDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('append_to_section is refused when a committed symlink resolves into .git', async () => {
    // append_to_section touches the filesystem itself (readFile/writeFile) rather than
    // forwarding to MCPVault, so forwardWrite's realpath guard doesn't cover it — this is
    // the same segment-re-check gap as the write_note case above, on appendTool's own path.
    await symlink('.git/config', join(fx.collabDir, 'Linked.md'));
    await git(['add', '-A'], fx.collabDir);
    await git(['commit', '-m', 'collab: add malicious symlink'], fx.collabDir);
    await git(['push', 'origin', 'main'], fx.collabDir);

    const before = await readFile(join(fx.serverDir, '.git', 'config'), 'utf8');
    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Linked.md',
      heading: 'X',
      text: 'injected',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(join(fx.serverDir, '.git', 'config'), 'utf8')).toBe(before);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('list_directory omits .obsidian', async () => {
    const res = await callTool(srv.client, 'list_directory', { path: '' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain('.obsidian');
  });

  it('list_directory of .git is refused by the wrapper, not silently emptied', async () => {
    // MCPVault's own filter only strips restricted entries out of the listing, so
    // `list_directory({path: '.git'})` "succeeds" with an empty result today — the
    // wrapper never refuses the call itself the way it refuses a .git write. Relying on
    // per-entry filtering as the only containment is exactly the single-layer trust the
    // read side is missing relative to writes.
    const res = await callTool(srv.client, 'list_directory', { path: '.git' });
    expect(res.isError).toBe(true);
  });

  it('read_multiple_notes is refused wholesale when one path targets .git', async () => {
    // MCPVault denies the individual path internally but reports it in a non-error "err"
    // array rather than isError, so a caller that only checks isError sees this as a
    // successful batch read. The wrapper must refuse the whole call before forwarding.
    const res = await callTool(srv.client, 'read_multiple_notes', {
      paths: ['Inbox/Beta.md', '.git/config'],
    });
    expect(res.isError).toBe(true);
  });
});
