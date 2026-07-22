import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import {
  HiddenIgnoredWriteError,
  LockError,
  Transactor,
  type TransactorConfig,
} from '../../src/transaction.js';

vi.mock('node:fs/promises', { spy: true });

// Every Transactor test builds the same config; centralize the defaults (Test Agent
// author, obsidian-git-mcp service, zero throttle, no retries, no-op validation) so a
// test declares only what it varies through overrides.
function makeTransactor(fx: Fixture, overrides: Partial<TransactorConfig> = {}): Transactor {
  return new Transactor({
    vaultPath: fx.serverDir,
    branch: 'main',
    remote: 'origin',
    collaborator: { name: 'Test Agent', email: 'agent@test.local' },
    service: { name: 'obsidian-git-mcp', email: 'service@obsidian-git-mcp.local' },
    readFreshnessMs: 0,
    maxPushRetries: 0,
    validateChangedFile: async () => {},
    ...overrides,
  });
}

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
    const transactor = makeTransactor(fx, {
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
      const transactor = makeTransactor(fx);

      const err: unknown = await transactor.reconcileAtStartup().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockError);
      expect((err as Error).message).toMatch(new RegExp(`live pid ${foreignPid}`));
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('Transactor ignored-file change signal', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('fingerprints already-ignored files by stat, never by reading their content', async () => {
    // Regression guard for the perf fix: an ignored tree (e.g. .obsidian/) can hold
    // multi-MB files, and ignoredFingerprint() runs twice per transact(), so it must
    // never read file contents — only stat metadata.
    await fx.collabWrite('.gitignore', 'private/\n', 'collab: ignore private/');
    // Sync .gitignore into serverDir before creating the ignored file: transact() only
    // fetches/merges once it runs, and until .gitignore lands locally the file below
    // would be untracked (dirty), not ignored.
    await git(['fetch', 'origin', 'main'], fx.serverDir);
    await git(['merge', '--ff-only', 'origin/main'], fx.serverDir);
    await mkdir(join(fx.serverDir, 'private'), { recursive: true });
    const ignoredPath = join(fx.serverDir, 'private', 'notes.md');
    await writeFile(ignoredPath, 'x'.repeat(1024));

    const transactor = makeTransactor(fx);

    const readFileSpy = vi.mocked(fsPromises.readFile);
    const lstatSpy = vi.mocked(fsPromises.lstat);
    readFileSpy.mockClear();
    lstatSpy.mockClear();

    await transactor.transact('touch a tracked file', async () => {
      await writeFile(join(fx.serverDir, 'Inbox', 'Beta.md'), '# Beta\n\nupdated\n');
    });

    expect(lstatSpy.mock.calls.some(([path]) => path === ignoredPath)).toBe(true);
    expect(readFileSpy.mock.calls.some(([path]) => path === ignoredPath)).toBe(false);
  });

  it('refuses the whole transaction when a mutation touches a tracked file and creates a newly-ignored one', async () => {
    // git add -A cannot stage a gitignored path, so committing the tracked change
    // alongside would push a partial write and leave the ignored file on disk. The whole
    // transaction must roll back instead — tracked edit reverted, ignored file removed.
    // Driven through the Transactor directly because no single tool call both edits a
    // tracked note and creates an ignored one.
    await fx.collabWrite('.gitignore', 'private/\n', 'collab: ignore private/');
    // Sync .gitignore before the write, or private/notes.md is untracked (dirty), not
    // ignored — transact() snapshots the ignored set before its own fetch/merge runs.
    await git(['fetch', 'origin', 'main'], fx.serverDir);
    await git(['merge', '--ff-only', 'origin/main'], fx.serverDir);

    const transactor = makeTransactor(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const preRemote = await git(['rev-parse', 'main'], fx.bareDir);
    const trackedPath = join(fx.serverDir, 'Inbox', 'Beta.md');
    const trackedBefore = await fsPromises.readFile(trackedPath, 'utf8');
    const ignoredPath = join(fx.serverDir, 'private', 'notes.md');

    const err: unknown = await transactor
      .transact('tracked edit plus a newly-ignored file', async () => {
        await writeFile(trackedPath, '# Beta\n\nmutated body\n');
        await mkdir(join(fx.serverDir, 'private'), { recursive: true });
        await writeFile(ignoredPath, '# Private\n');
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HiddenIgnoredWriteError);
    expect((err as Error).message.toLowerCase()).toContain('gitignore');
    // Nothing pushed; both effects rolled back.
    expect(await git(['rev-parse', 'main'], fx.bareDir)).toBe(preRemote);
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
    expect(await fsPromises.readFile(trackedPath, 'utf8')).toBe(trackedBefore);
    expect(existsSync(ignoredPath)).toBe(false);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });
});
