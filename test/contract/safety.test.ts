import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
  headShaOf,
  startServer,
  textOf,
  type TestServer,
} from '../helpers.js';

describe('transaction safety', () => {
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

  it('a write containing conflict markers is rejected and rolled back', async () => {
    srv = await startServer(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const [preRemote] = await fx.bareLog('%H', 1);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Bad.md',
      content: '# Bad\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('conflict marker');

    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('broken frontmatter YAML never reaches the remote', async () => {
    srv = await startServer(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const [preRemote] = await fx.bareLog('%H', 1);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Broken.md',
      content: '---\nfoo: [unclosed\n---\n\nbody\n',
    });
    // Either the tool layer or the transaction validator may reject it — the contract
    // is only that nothing lands.
    expect(res.isError).toBe(true);

    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('a non-conflicting concurrent push is absorbed by bounded retry', async () => {
    let fired = false;
    srv = await startServer(fx, {
      testHooks: {
        beforePush: async () => {
          if (!fired) {
            fired = true;
            await fx.collabWrite('Inbox/Other.md', 'other\n', 'collab: add Other');
          }
        },
      },
    });

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Mine.md',
      content: '# Mine\n',
    });
    expect(res.isError).toBeFalsy();
    const sha = commitShaOf(res);

    const subjects = await fx.bareLog('%H %s', 5);
    expect(subjects.some((l) => l.includes('collab: add Other'))).toBe(true);
    // Our commit rebased on top of the collaborator's and is the remote head.
    expect(subjects[0]!.startsWith(sha)).toBe(true);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('a conflicting concurrent edit is refused and nothing is lost', async () => {
    const collabVersion = '# Alpha\n\nCollaborator rewrote everything.\n';
    let fired = false;
    srv = await startServer(fx, {
      testHooks: {
        beforePush: async () => {
          if (!fired) {
            fired = true;
            await fx.collabWrite('Projects/Alpha.md', collabVersion, 'collab: rewrite Alpha');
          }
        },
      },
    });
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);

    const res = await callTool(srv.client, 'patch_note', {
      path: 'Projects/Alpha.md',
      oldString: 'Alpha is in flight.',
      newString: 'Alpha has shipped.',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('conflict');

    // The collaborator's version survives untouched on the remote.
    expect(await fx.remoteFile('Projects/Alpha.md')).toBe(collabVersion);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('a mid-transaction failure restores the checkout exactly', async () => {
    srv = await startServer(fx, {
      testHooks: {
        beforePush: async () => {
          throw new Error('boom');
        },
      },
    });
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const [preRemote] = await fx.bareLog('%H', 1);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Doomed.md',
      content: '# Doomed\n',
    });
    expect(res.isError).toBe(true);

    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('a push whose ACK is lost but which landed is treated as success', async () => {
    // Simulates the lost-ACK case: the commit reaches the remote, the remote advances
    // further, and our push attempt then fails — with zero retries left. The transaction
    // must recognize its commit already landed instead of rolling back and reporting
    // "nothing was changed" for a write that is on the remote.
    let fired = false;
    srv = await startServer(fx, {
      maxPushRetries: 0,
      testHooks: {
        beforePush: async () => {
          if (fired) return;
          fired = true;
          await git(['push', 'origin', 'HEAD:main'], fx.serverDir);
          await fx.collabWrite('Inbox/Other.md', 'other\n', 'collab: on top');
        },
      },
    });

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Landed.md',
      content: '# Landed\n',
    });
    expect(res.isError).toBeFalsy();
    const sha = commitShaOf(res);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const log = await fx.bareLog('%H %s', 5);
    expect(log.some((l) => l.startsWith(sha))).toBe(true);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('a read raced with a write never returns content newer than its stamped SHA', async () => {
    srv = await startServer(fx);
    let prev = 'Alpha is in flight.';
    for (let i = 0; i < 6; i++) {
      const marker = `revision-${i}.`;
      const [w, r] = await Promise.all([
        callTool(srv.client, 'patch_note', {
          path: 'Projects/Alpha.md',
          oldString: prev,
          newString: marker,
        }),
        callTool(srv.client, 'read_note', { path: 'Projects/Alpha.md' }),
      ]);
      expect(w.isError).toBeFalsy();
      const sha = headShaOf(r);
      const atSha = await git(['show', `${sha}:Projects/Alpha.md`], fx.serverDir);
      // Whatever revision the read saw must be exactly the one at its stamped SHA.
      expect(textOf(r).includes(marker)).toBe(atSha.includes(marker));
      prev = marker;
    }
  });

  it('a dirty checkout refuses writes until reconciled', async () => {
    srv = await startServer(fx);
    const [preRemote] = await fx.bareLog('%H', 1);
    await writeFile(join(fx.serverDir, 'Stray.md'), 'stray uncommitted debris\n');

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/New.md',
      content: '# New\n',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('dirty');

    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
  });
});
