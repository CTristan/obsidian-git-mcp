import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { LockError, Transactor } from '../../src/transaction.js';

describe('Transactor.status', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('reports ahead/behind against the same headSha it returns, even when HEAD moves mid-call', async () => {
    // status() runs outside the enqueue mutex, so a concurrent transact() on this same
    // checkout can commit and push — advancing HEAD — between status()'s rev-parse HEAD
    // and its ahead/behind computation. Simulate that landing right after status()'s
    // first git call.
    let calls = 0;
    const transactor = new Transactor({
      vaultPath: fx.serverDir,
      branch: 'main',
      remote: 'origin',
      collaborator: { name: 'Test Agent', email: 'agent@test.local' },
      service: { name: 'obsidian-git-mcp', email: 'service@obsidian-git-mcp.local' },
      readFreshnessMs: 0,
      maxPushRetries: 0,
      validateChangedFile: async () => {},
      onGitCall: async () => {
        calls++;
        if (calls === 1) {
          await writeFile(`${fx.serverDir}/Inbox/Concurrent.md`, '# Concurrent\n');
          await git(['add', '-A'], fx.serverDir);
          await git(['commit', '-m', 'Concurrent write'], fx.serverDir);
          await git(['push', 'origin', 'HEAD:main'], fx.serverDir);
        }
      },
    });

    const headBefore = await git(['rev-parse', 'HEAD'], fx.serverDir);

    const status = await transactor.status();

    expect(status.headSha).toBe(headBefore);
    // The ahead/behind counts must describe status.headSha's relationship to the
    // remote, not whatever HEAD happens to be by the time the count is computed.
    const expectedAhead = Number(
      await git(['rev-list', '--count', `origin/main..${status.headSha}`], fx.serverDir),
    );
    const expectedBehind = Number(
      await git(['rev-list', '--count', `${status.headSha}..origin/main`], fx.serverDir),
    );
    expect(status.ahead).toBe(expectedAhead);
    expect(status.behind).toBe(expectedBehind);
  });
});

describe('Transactor.reconcileAtStartup', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('treats EPERM from process.kill as a live lock holder, not a dead one', async () => {
    // EPERM means the pid exists but belongs to another user/permission domain — still
    // alive. Only ESRCH (no such process) is safe to treat as dead.
    const foreignPid = 424242;
    await writeFile(join(fx.serverDir, '.git', 'obsidian-git-mcp.lock'), `pid ${foreignPid}\n`);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === foreignPid) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    try {
      const transactor = new Transactor({
        vaultPath: fx.serverDir,
        branch: 'main',
        remote: 'origin',
        collaborator: { name: 'Test Agent', email: 'agent@test.local' },
        service: { name: 'obsidian-git-mcp', email: 'service@obsidian-git-mcp.local' },
        readFreshnessMs: 0,
        maxPushRetries: 0,
        validateChangedFile: async () => {},
      });

      const err: unknown = await transactor.reconcileAtStartup().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockError);
      expect((err as Error).message).toMatch(new RegExp(`live pid ${foreignPid}`));
    } finally {
      killSpy.mockRestore();
    }
  });
});
