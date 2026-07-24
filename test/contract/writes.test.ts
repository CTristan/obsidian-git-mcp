import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, SEED_NOTES, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
  expectCleanCheckout,
  SERVICE_EMAIL,
  SERVICE_NAME,
  startServer,
  TEST_COLLABORATOR,
  type TestServer,
} from '../helpers.js';

describe('writes', () => {
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

  it('write_note lands an attributed commit on the remote and returns its SHA', async () => {
    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/New.md',
      content: '# New\n\nHello from the contract suite.\n',
    });
    expect(res.isError).toBeFalsy();

    const sha = commitShaOf(res);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const [head] = await fx.bareLog('%H|%an|%ae|%cn|%ce|%s', 1);
    const [h, authorName, authorEmail, committerName, committerEmail, subject] = head!.split('|');
    expect(h).toBe(sha);
    expect(authorName).toBe(TEST_COLLABORATOR.name);
    expect(authorEmail).toBe(TEST_COLLABORATOR.email);
    expect(committerName).toBe(SERVICE_NAME);
    expect(committerEmail).toBe(SERVICE_EMAIL);
    expect(subject).toContain('Inbox/New.md');

    // The checkout ends the transaction clean and on the pushed commit.
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(sha);

    // And the remote holds the exact bytes that were written.
    expect(await fx.remoteFile('Inbox/New.md')).toBe('# New\n\nHello from the contract suite.\n');
  });

  it('patch_note changes only the intended bytes', async () => {
    const res = await callTool(srv.client, 'patch_note', {
      path: 'Projects/Alpha.md',
      oldString: 'Alpha is in flight.',
      newString: 'Alpha has shipped.',
    });
    expect(res.isError).toBeFalsy();
    expect(commitShaOf(res)).toBe(await fx.bareHead());

    const expected = SEED_NOTES['Projects/Alpha.md']!.replace(
      'Alpha is in flight.',
      'Alpha has shipped.',
    );
    expect(await fx.remoteFile('Projects/Alpha.md')).toBe(expected);
  });

  it('update_frontmatter updates the field and leaves the body byte-identical', async () => {
    const res = await callTool(srv.client, 'update_frontmatter', {
      path: 'Projects/Alpha.md',
      frontmatter: { status: 'done' },
      merge: true,
    });
    expect(res.isError).toBeFalsy();
    expect(commitShaOf(res)).toBe(await fx.bareHead());

    const remote = await fx.remoteFile('Projects/Alpha.md');
    const seedBody = matter(SEED_NOTES['Projects/Alpha.md']!).content;
    expect(remote.endsWith(seedBody)).toBe(true);
    // Sibling keys survive the merge semantically — MCPVault normalizes flow-style
    // whitespace ([project] -> [ project ]), so assert the parsed data, not the bytes.
    expect(matter(remote).data).toEqual({ tags: ['project'], status: 'done' });
  });

  it('write_note through an in-vault symlink updates the target note', async () => {
    // Seed a real note plus a relative in-vault symlink pointing at it, via the
    // collaborator clone, so the server picks the pair up on its next fetch. Clone-staging
    // must keep in-vault symlink semantics byte-identical: the delegated write runs
    // against a symlink-preserving private clone, so following Alias.md onto Target.md
    // works exactly as it does on a plain checkout — the link is content, not an escape.
    await writeFile(join(fx.collabDir, 'Target.md'), '# Target\n\noriginal.\n');
    await symlink('Target.md', join(fx.collabDir, 'Alias.md'));
    await git(['add', '-A'], fx.collabDir);
    await git(['commit', '-m', 'collab: add note and in-vault alias symlink'], fx.collabDir);
    await git(['push', 'origin', 'main'], fx.collabDir);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Alias.md',
      content: '# Target\n\nrewritten through the alias.\n',
    });
    expect(res.isError).toBeFalsy();

    // The write followed the symlink onto the real note — Target.md carries the new bytes.
    expect(await fx.remoteFile('Target.md')).toBe('# Target\n\nrewritten through the alias.\n');

    // And Alias.md is still a symlink (tree mode 120000) whose blob is exactly its target
    // path — not clobbered into a regular file holding the content.
    const entry = await git(['ls-tree', 'main', 'Alias.md'], fx.bareDir);
    expect(entry.startsWith('120000 ')).toBe(true);
    expect(await fx.remoteFile('Alias.md')).toBe('Target.md');
  });

  it('a failed delegated write leaves the checkout and remote untouched', async () => {
    // The delegated write runs against a private clone; when the inner tool errors (here a
    // patch whose oldString is nowhere in the note), nothing is copied back and the
    // transaction aborts — so both the local checkout and the remote stay exactly as they
    // were. A checkout with no commit ahead of the remote (not merely a clean working tree)
    // rules out a local commit that silently failed to push.
    const preRemote = await fx.bareHead();

    const res = await callTool(srv.client, 'patch_note', {
      path: 'Projects/Alpha.md',
      oldString: 'this exact text does not occur anywhere in Alpha.',
      newString: 'unreachable replacement',
    });
    expect(res.isError).toBe(true);

    await expectCleanCheckout(fx);
    expect(await fx.bareHead()).toBe(preRemote);
  });
});
