import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
    const preRemote = await fx.bareHead();

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Bad.md',
      content: '# Bad\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('conflict marker');

    const postRemote = await fx.bareHead();
    expect(postRemote).toBe(preRemote);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('broken frontmatter YAML never reaches the remote', async () => {
    srv = await startServer(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const preRemote = await fx.bareHead();

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Broken.md',
      content: '---\nfoo: [unclosed\n---\n\nbody\n',
    });
    // Either the tool layer or the transaction validator may reject it — the contract
    // is only that nothing lands.
    expect(res.isError).toBe(true);

    const postRemote = await fx.bareHead();
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

  it('a clean rebase that splices in invalid content is refused, not pushed', async () => {
    // The collaborator edits only the frontmatter (breaking its YAML) while our write
    // edits only the body — non-overlapping regions, so the rebase applies cleanly with
    // no textual conflict. That "clean" merge still produces a file that was never
    // validated, since the collaborator's write bypasses this server entirely.
    const collabVersion = [
      '---',
      'tags: [project',
      'status: active',
      '---',
      '',
      '# Alpha',
      '',
      '## Status',
      '',
      'Alpha is in flight.',
      '',
      '## Decisions',
      '',
      '- Ship early.',
      '',
    ].join('\n');
    let fired = false;
    srv = await startServer(fx, {
      testHooks: {
        beforePush: async () => {
          if (!fired) {
            fired = true;
            await fx.collabWrite('Projects/Alpha.md', collabVersion, 'collab: break frontmatter');
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

    // The collaborator's (invalid) version is what actually landed — the rebase-merged
    // content, which spliced our valid body edit onto their broken frontmatter, must
    // never reach the remote unvalidated.
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
    const preRemote = await fx.bareHead();

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Doomed.md',
      content: '# Doomed\n',
    });
    expect(res.isError).toBe(true);

    const postRemote = await fx.bareHead();
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

  it('a symlink escaping the vault is refused without deleting the external target', async () => {
    // MCPVault's own resolvePath already refuses a symlink whose EXISTING target
    // resolves outside the vault, so the wrapper's post-write realpath guard only ever
    // sees the escape for a *dangling* symlink: MCPVault can't realpath a target that
    // doesn't exist yet, falls back to checking the symlink's parent (inside the vault,
    // so no refusal), and the write itself creates the file at the symlink's target.
    // Only then does the wrapper's guard catch the escape — and it must refuse without
    // deleting the file that write just created outside the vault.
    const target = join(fx.outsideDir, 'external.md');
    await symlink(target, join(fx.collabDir, 'Linked.md'));
    await git(['add', '-A'], fx.collabDir);
    await git(['commit', '-m', 'collab: add external symlink'], fx.collabDir);
    await git(['push', 'origin', 'main'], fx.collabDir);

    srv = await startServer(fx);
    const res = await callTool(srv.client, 'write_note', {
      path: 'Linked.md',
      content: 'pwned\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('a dirty checkout refuses writes until reconciled', async () => {
    srv = await startServer(fx);
    const preRemote = await fx.bareHead();
    await writeFile(join(fx.serverDir, 'Stray.md'), 'stray uncommitted debris\n');

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/New.md',
      content: '# New\n',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('dirty');

    const postRemote = await fx.bareHead();
    expect(postRemote).toBe(preRemote);

    // The recovery half: a restart reconciles the checkout and writes work again.
    await srv.close();
    srv = await startServer(fx);
    const retry = await callTool(srv.client, 'write_note', {
      path: 'Inbox/New.md',
      content: '# New\n',
    });
    expect(retry.isError).toBeFalsy();
  });

  it('a write that only rewrites an already-gitignored path never reports a hidden success', async () => {
    await fx.collabWrite('.gitignore', 'private/\n', 'collab: ignore private/');

    srv = await startServer(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);

    // Present and ignored *before* the transaction starts — the specific case
    // changedPaths()/newlyIgnored can't see, since the path's ignored membership never
    // changes across the mutation, only its content does.
    const ignoredPath = join(fx.serverDir, 'private', 'notes.md');
    const original = '# Secret\n\noriginal\n';
    await mkdir(join(fx.serverDir, 'private'), { recursive: true });
    await writeFile(ignoredPath, original);

    const res = await callTool(srv.client, 'write_note', {
      path: 'private/notes.md',
      content: '# Secret\n\nmutated\n',
    });

    const postContent = await readFile(ignoredPath, 'utf8');
    // The one outcome that must never happen: reporting success against an unchanged
    // HEAD while the mutation actually landed on disk, unvalidated and uncommitted.
    const hiddenSuccess = !res.isError && commitShaOf(res) === preHead && postContent !== original;
    expect(hiddenSuccess).toBe(false);
  });
});
