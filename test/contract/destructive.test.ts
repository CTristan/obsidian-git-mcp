import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
  commitSymlink,
  commitSymlinkChain,
  expectRolledBack,
  SERVICE_EMAIL,
  SERVICE_NAME,
  startServer,
  TEST_COLLABORATOR,
  textOf,
  type TestServer,
} from '../helpers.js';

async function expectAttributedCommit(res: CallToolResult, fx: Fixture): Promise<void> {
  expect(res.isError).toBeFalsy();
  expect(commitShaOf(res)).toBe(await fx.bareHead());

  const [head] = await fx.bareLog('%H|%an|%ae|%cn|%ce|%s', 1);
  const [h, authorName, authorEmail, committerName, committerEmail] = head!.split('|');
  expect(h).toBe(commitShaOf(res));
  expect(authorName).toBe(TEST_COLLABORATOR.name);
  expect(authorEmail).toBe(TEST_COLLABORATOR.email);
  expect(committerName).toBe(SERVICE_NAME);
  expect(committerEmail).toBe(SERVICE_EMAIL);
}

describe('destructive tools', () => {
  let fx: Fixture;
  let srv: TestServer | undefined;

  beforeEach(async () => {
    fx = await createFixture();
    srv = undefined;
  });

  afterEach(async () => {
    await srv?.close();
    await fx.cleanup();
  });

  it('destructive tools are hidden and refused by default', async () => {
    srv = await startServer(fx);
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('delete_note');
    expect(names).not.toContain('move_note');
    expect(names).not.toContain('move_file');

    const res = await callTool(srv.client, 'delete_note', { path: 'Inbox/Beta.md' });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('disabled');

    const move = await callTool(srv.client, 'move_note', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Archive/Beta.md',
    });
    expect(move.isError).toBe(true);
    expect(textOf(move).toLowerCase()).toContain('disabled');

    const moveFile = await callTool(srv.client, 'move_file', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Archive/Beta.md',
      confirmOldPath: 'Inbox/Beta.md',
      confirmNewPath: 'Archive/Beta.md',
    });
    expect(moveFile.isError).toBe(true);
    expect(textOf(moveFile).toLowerCase()).toContain('disabled');

    // The note is still on the remote, untouched.
    expect(await git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).toContain('squirrels');
  });

  it('move_note works when destructive tools are enabled', async () => {
    srv = await startServer(fx, { allowDestructive: true });
    const { tools } = await srv.client.listTools();
    expect(tools.map((t) => t.name)).toContain('move_note');

    const res = await callTool(srv.client, 'move_note', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Archive/Beta.md',
    });
    await expectAttributedCommit(res, fx);

    expect(await git(['show', 'main:Archive/Beta.md'], fx.bareDir)).toContain('squirrels');
    await expect(git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).rejects.toThrow();
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('move_file works when destructive tools are enabled', async () => {
    srv = await startServer(fx, { allowDestructive: true });
    const { tools } = await srv.client.listTools();
    expect(tools.map((t) => t.name)).toContain('move_file');

    const res = await callTool(srv.client, 'move_file', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Archive/Beta.md',
      confirmOldPath: 'Inbox/Beta.md',
      confirmNewPath: 'Archive/Beta.md',
    });
    await expectAttributedCommit(res, fx);

    expect(await git(['show', 'main:Archive/Beta.md'], fx.bareDir)).toContain('squirrels');
    await expect(git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).rejects.toThrow();
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('delete_note works when destructive tools are enabled', async () => {
    srv = await startServer(fx, { allowDestructive: true });
    const { tools } = await srv.client.listTools();
    expect(tools.map((t) => t.name)).toContain('delete_note');

    const res = await callTool(srv.client, 'delete_note', {
      path: 'Inbox/Beta.md',
      confirmPath: 'Inbox/Beta.md',
    });
    await expectAttributedCommit(res, fx);

    await expect(git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).rejects.toThrow();
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('delete_note through a symlink is refused without deleting the external target', async () => {
    // unlink() on a symlink removes the link itself, never its target, so the exposure
    // here isn't the external file's content — it's that the delete would otherwise
    // succeed and commit/push the symlink's removal without ever being flagged as the
    // escape it is.
    const target = join(fx.outsideDir, 'precious.md');
    const before = '# Precious\n\ndo not delete\n';
    await writeFile(target, before);
    await commitSymlink(fx, 'Linked.md', target, 'collab: add symlink to outside target');

    srv = await startServer(fx, { allowDestructive: true });
    const preRemote = await fx.bareHead();
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const res = await callTool(srv.client, 'delete_note', {
      path: 'Linked.md',
      confirmPath: 'Linked.md',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(before);
    await expectRolledBack(fx, preRemote, preHead);
  });

  it('move_note through a symlink is refused without copying the external target into the vault', async () => {
    // moveNote reads through the symlink (following it, unlike unlink) and writes that
    // content to newPath inside the vault — an exfiltration path, not just a corruption
    // one, so this must be refused before MCPVault ever reads the external file.
    const target = join(fx.outsideDir, 'secret.md');
    const before = '# Secret\n\nexternal content\n';
    await writeFile(target, before);
    await commitSymlink(fx, 'Linked.md', target, 'collab: add symlink to outside target');

    srv = await startServer(fx, { allowDestructive: true });
    const preRemote = await fx.bareHead();
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const res = await callTool(srv.client, 'move_note', {
      oldPath: 'Linked.md',
      newPath: 'Exfiltrated.md',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(before);
    await expectRolledBack(fx, preRemote, preHead);
  });

  it('move_note is refused when newPath is a 2-hop symlink chain resolving outside the vault', async () => {
    // Chained version of the single-hop test above: newPath's first hop still resolves
    // in-vault, so a resolver that stops after one readlink() approves it — only for the
    // second hop to point at a dangling external target that moveNote's writeFile then
    // followed. overwrite:true is required because the chain's first link ("Hop1.md")
    // already exists on disk as a symlink, so MCPVault's own exclusive-write check would
    // otherwise refuse the call for an unrelated reason before our guard is exercised.
    // A real in-vault note as oldPath lets the test assert it survives untouched — with
    // the bug, moveNote would have deleted it after "successfully" relocating its
    // content to the external target.
    const externalTarget = join(fx.outsideDir, 'exfil.md');
    await commitSymlinkChain(
      fx,
      [
        ['Hop1.md', 'Hop2.md'],
        ['Hop2.md', externalTarget],
      ],
      'collab: add 2-hop symlink chain escaping the vault',
    );

    srv = await startServer(fx, { allowDestructive: true });
    const preRemote = await fx.bareHead();
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const res = await callTool(srv.client, 'move_note', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Hop1.md',
      overwrite: true,
    });
    expect(res.isError).toBe(true);
    expect(existsSync(externalTarget)).toBe(false);
    expect(await git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).toContain('squirrels');
    await expectRolledBack(fx, preRemote, preHead);
  });
});
