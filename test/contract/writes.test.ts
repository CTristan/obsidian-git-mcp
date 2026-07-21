import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, SEED_NOTES, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
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
  });

  it('patch_note changes only the intended bytes', async () => {
    const res = await callTool(srv.client, 'patch_note', {
      path: 'Projects/Alpha.md',
      oldString: 'Alpha is in flight.',
      newString: 'Alpha has shipped.',
    });
    expect(res.isError).toBeFalsy();

    const remote = await git(['show', 'main:Projects/Alpha.md'], fx.bareDir);
    const expected = SEED_NOTES['Projects/Alpha.md']!.replace(
      'Alpha is in flight.',
      'Alpha has shipped.',
    );
    expect(`${remote}\n`).toBe(expected);
  });

  it('update_frontmatter updates the field and leaves the body byte-identical', async () => {
    const res = await callTool(srv.client, 'update_frontmatter', {
      path: 'Projects/Alpha.md',
      frontmatter: { status: 'done' },
      merge: true,
    });
    expect(res.isError).toBeFalsy();

    const remote = `${await git(['show', 'main:Projects/Alpha.md'], fx.bareDir)}\n`;
    const seedBody = SEED_NOTES['Projects/Alpha.md']!.split('---\n')[2]!;
    expect(remote.endsWith(seedBody)).toBe(true);
    expect(remote).toContain('status: done');
    expect(remote).not.toContain('status: active');
  });
});
