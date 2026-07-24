import { existsSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import * as gitModule from '../../src/git.js';
import {
  HiddenIgnoredWriteError,
  LockError,
  Transactor,
  type TransactorConfig,
} from '../../src/transaction.js';

vi.mock('node:fs/promises', { spy: true });
vi.mock('../../src/git.js', { spy: true });

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
    refuseExecutableNote: async () => {},
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

  it('holds the on-disk write lock across its reconcile mutations, so a peer cannot race the worktree', async () => {
    // reconcileAtStartup mutates the shared checkout (fetch/reset/clean/merge) the same way
    // transact() does, so it must hold the same on-disk lock over those mutations — otherwise
    // a peer process (a rolling-restart overlap) can slip into transact() between the stale-lock
    // release and the reset/merge path and race the worktree. Seed uncommitted debris so
    // reconcile takes the reset/clean mutation path (not just an ff-only merge), then use the
    // onGitCall seam to observe the lockfile's presence around each mutating git call.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(join(fx.serverDir, 'Junk.md'), 'crash debris\n');

    const mutations = new Set(['fetch', 'reset', 'clean', 'merge']);
    const lockPresentDuring: boolean[] = [];
    const transactor = makeTransactor(fx, {
      onGitCall: (args) => {
        if (mutations.has(args[0]!)) {
          lockPresentDuring.push(existsSync(lockPath));
        }
      },
    });

    await transactor.reconcileAtStartup();

    // At least one worktree mutation ran, and every one of them ran while the lock was held.
    expect(lockPresentDuring.length).toBeGreaterThan(0);
    expect(lockPresentDuring.every((present) => present)).toBe(true);
    // The lock is released once reconcile finishes, or every later write would deadlock.
    expect(existsSync(lockPath)).toBe(false);
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

describe('Transactor lockfile format round-trip', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('reads back the holder pid through the real acquireLock write path, so a format change breaks the parser too', async () => {
    // acquireLock's write format and clearDeadLock's parser must agree on the exact
    // lockfile text; a test that hardcodes the "pid N" string can't catch a write-format
    // change that desyncs the two. Drive the real write path and read it back: acquireLock
    // records THIS process's pid, which is alive, so clearDeadLock must recognize the
    // holder and refuse. A broken round-trip would instead parse no pid, treat the live
    // lock as dead, and silently clear it.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    const transactor = makeTransactor(fx);

    await transactor['acquireLock']();

    const err: unknown = await transactor['clearDeadLock']().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockError);
    expect((err as Error).message).toMatch(new RegExp(`live pid ${process.pid}\\b`));
    // The live holder's lock stays put — clearDeadLock refused rather than clearing it.
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('Transactor clearDeadLock TOCTOU', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('refuses to clear a stale lock a peer re-acquired between the staleness read and the claim', async () => {
    // clearDeadLock reads the lockfile to check the holder's liveness, then claims the inode
    // with a rename in a separate await. A peer process can re-acquire the lock (writing a
    // fresh, LIVE pid) in that gap, and a blind removal would then delete the peer's live lock
    // — letting reconcile's reset --hard/clean race the peer's in-flight transaction. Plant a
    // stale (dead-pid) lock, then use the process.kill seam — the last thing clearDeadLock does
    // before it claims the inode — to overwrite the lockfile with THIS process's live pid at
    // that exact moment. A correct clear renames, sees the claimed bytes changed, restores the
    // live lock, and refuses instead of proceeding to delete it.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    const deadPid = 999999;
    await writeFile(lockPath, `pid ${deadPid} at ${new Date().toISOString()}\n`);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) {
        // The staleness snapshot is taken; simulate the peer re-acquiring right now.
        writeFileSync(lockPath, `pid ${process.pid} at ${new Date().toISOString()}\n`);
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err; // deadPid reads as dead, so the clear proceeds toward the rename claim
      }
      return true;
    });

    try {
      const transactor = makeTransactor(fx);
      const err: unknown = await transactor['clearDeadLock']().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LockError);
      // The peer's live lock must survive — the clear restored and refused rather than deleting it.
      expect(existsSync(lockPath)).toBe(true);
      expect(await fsPromises.readFile(lockPath, 'utf8')).toContain(`pid ${process.pid}`);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('Transactor stale-lock reclaim', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('refuses to start on an empty lockfile instead of clearing it, since a holder may be mid-acquire', async () => {
    // acquireLock creates the lockfile with open('wx') and writes its pid on the next await,
    // so a peer's lock is momentarily empty on disk. Reading '' yields no parseable pid, and
    // clearing on "no pid" would delete that live holder's lock out from under it. Only a
    // provably-dead holder is safe to clear; an unreadable pid must refuse, not clear.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(lockPath, '');

    const transactor = makeTransactor(fx);
    const err: unknown = await transactor.reconcileAtStartup().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LockError);
    // The empty (mid-acquire) lock must survive untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect(await fsPromises.readFile(lockPath, 'utf8')).toBe('');
  });

  it('clears a non-empty unparseable lockfile as crash debris, since a live holder never writes garbage', async () => {
    // acquireLock only ever writes the serialized "pid N" payload, so non-empty unparseable
    // content is a process that crashed mid-write — dead debris that must never block writes
    // forever. It clears through the same safe rename-claim path a dead recorded pid takes,
    // and (unlike an empty lock) does not refuse: garbage is not a live holder mid-acquire.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(lockPath, 'crashed mid-write\n');
    const renameSpy = vi.mocked(fsPromises.rename);
    renameSpy.mockClear();

    const transactor = makeTransactor(fx);
    await transactor.reconcileAtStartup();

    // Reclaimed via rename (not a blind unlink), then startup proceeded and released its lock.
    expect(renameSpy.mock.calls.some(([from]) => from === lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([0, -1])(
    'clears a lockfile recording non-positive pid %d as corruption, never treating it as a live holder',
    async (corruptPid) => {
      // serializeLock always records Node's process.pid, which is positive, so a non-positive
      // pid can only come from a corrupted or tampered lockfile. It matters because process.kill
      // reinterprets a non-positive pid as a process GROUP, not the recorded holder: kill(0, 0)
      // queries the caller's own group and kill(-1, 0) broadcasts, both of which answer "alive"
      // unconditionally. An unguarded liveness check would then read such a lock as a live holder
      // forever and deadlock the crash-recovery path, so parseLockPid must reject it and let the
      // non-empty-garbage branch clear it through the same safe rename-claim a dead pid takes.
      const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
      await writeFile(lockPath, `pid ${corruptPid} at ${new Date().toISOString()}\n`);
      const renameSpy = vi.mocked(fsPromises.rename);
      renameSpy.mockClear();

      const transactor = makeTransactor(fx);
      await transactor.reconcileAtStartup();

      expect(renameSpy.mock.calls.some(([from]) => from === lockPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it('reclaims a provably-dead stale lock by renaming it aside, never by blind-unlinking the path', async () => {
    // A blind unlink(lockPath) races a peer that re-acquired between the liveness read and the
    // removal — it would delete the peer's fresh live lock. The fix claims the inspected inode
    // with an atomic rename (only one racer can move a given inode) instead, so a dead lock is
    // reclaimed by rename, and startup then proceeds and releases the lock it took.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    const deadPid = 999999;
    await writeFile(lockPath, `pid ${deadPid} at ${new Date().toISOString()}\n`);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });
    const renameSpy = vi.mocked(fsPromises.rename);
    renameSpy.mockClear();

    try {
      const transactor = makeTransactor(fx);
      await transactor.reconcileAtStartup();

      // The dead lock was reclaimed via a rename of the lockfile itself, not a path unlink.
      expect(renameSpy.mock.calls.some(([from]) => from === lockPath)).toBe(true);
      // Startup proceeded and released the lock it acquired.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('Transactor startup note scan', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('still rejects the whole scan when a note in a later concurrency wave fails refuseExecutableNote', async () => {
    // Regression guard for the wave-batched rewrite: the scan runs SCAN_CONCURRENCY (64)
    // notes at a time, so this seeds more tracked files than that and fails the
    // alphabetically-last one — guaranteeing it lands in a later wave than the first —
    // to prove a later wave's rejection still propagates instead of being swallowed by
    // an earlier wave's success.
    const total = 70;
    for (let i = 0; i < total; i++) {
      await writeFile(join(fx.serverDir, `Zulu-${String(i).padStart(3, '0')}.md`), `# ${i}\n`);
    }
    await git(['add', '-A'], fx.serverDir);
    await git(['commit', '-m', 'bulk notes'], fx.serverDir);
    await git(['push', 'origin', 'HEAD:main'], fx.serverDir);

    const failingPath = `Zulu-${String(total - 1).padStart(3, '0')}.md`;
    const seen: string[] = [];
    const transactor = makeTransactor(fx, {
      refuseExecutableNote: async (relPath) => {
        seen.push(relPath);
        if (relPath === failingPath) {
          throw new Error(`refusing ${failingPath}`);
        }
      },
    });

    const err: unknown = await transactor.reconcileAtStartup().catch((e: unknown) => e);

    expect((err as Error).message).toBe(`refusing ${failingPath}`);
    // The failing note sorts last, so its wave only runs once every earlier wave has
    // already completed — confirming the scan didn't stop at the first wave.
    expect(seen.length).toBeGreaterThan(64);
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

  it('removes a newly-ignored path that validateChangedFile itself refuses, not just the generic HiddenIgnoredWriteError case', async () => {
    // validateChangedFile throwing for a newly-ignored path (the mechanism that refuses
    // e.g. .obsidian/ writes by name) jumps straight past the unlink loop that normally
    // runs right before the generic HiddenIgnoredWriteError throw — reset --hard and
    // clean -fd can never remove a gitignored path, so without cleanup in the catch block
    // itself, the refused file is a permanent orphan on disk.
    await fx.collabWrite('.gitignore', 'private/\n', 'collab: ignore private/');
    await git(['fetch', 'origin', 'main'], fx.serverDir);
    await git(['merge', '--ff-only', 'origin/main'], fx.serverDir);

    const ignoredPath = join(fx.serverDir, 'private', 'notes.md');
    const transactor = makeTransactor(fx, {
      validateChangedFile: async (relPath) => {
        if (relPath === 'private/notes.md') {
          throw new Error('refusing private/notes.md by name');
        }
      },
    });
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);

    const err: unknown = await transactor
      .transact('creates a newly-ignored, by-name-refused file', async () => {
        await mkdir(join(fx.serverDir, 'private'), { recursive: true });
        await writeFile(ignoredPath, '# Private\n');
      })
      .catch((e: unknown) => e);

    expect((err as Error).message).toBe('refusing private/notes.md by name');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
    expect(existsSync(ignoredPath)).toBe(false);
  });
});

describe('Transactor.transact return shape', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('returns the pushed SHA alongside the mutation callback result', async () => {
    // transact is generic like readTransaction: it forwards whatever the mutate callback
    // produces back to the caller, so a delegated write consumes its result directly
    // instead of smuggling it out through a closure variable.
    const transactor = makeTransactor(fx);

    const { sha, result } = await transactor.transact('a tracked write', async () => {
      await writeFile(join(fx.serverDir, 'Inbox', 'Beta.md'), '# Beta\n\nupdated\n');
      return { note: 'Beta' };
    });

    // The returned sha is the commit that actually landed on the remote.
    expect(sha).toBe(await git(['rev-parse', 'main'], fx.bareDir));
    expect(sha).toBe(await git(['rev-parse', 'HEAD'], fx.serverDir));
    expect(result).toEqual({ note: 'Beta' });
  });

  it('forwards the callback result and the unchanged HEAD when the mutation touched nothing', async () => {
    // A no-op mutation commits nothing, so transact returns the pre-transaction HEAD as
    // its sha — but still forwards the callback's result, so the result channel is
    // independent of whether a commit landed.
    const transactor = makeTransactor(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);

    const { sha, result } = await transactor.transact('a no-op mutation', async () => 'no changes');

    expect(sha).toBe(preHead);
    expect(result).toBe('no changes');
  });
});

describe('Transactor network-operation timeouts', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('gives network git operations (fetch/push) a longer timeout than the 30s local default', async () => {
    // runGit hard-caps every command at 30s unless a timeoutMs override is passed. That
    // ceiling is right for fast local plumbing but wrong for fetch/push against a large
    // vault or a slow remote, which can legitimately run for minutes — a 30s kill there
    // fails a healthy write and rolls it back. Assert the network call sites raise the
    // ceiling while local plumbing keeps the default.
    const runGitSpy = vi.mocked(gitModule.runGit);
    runGitSpy.mockClear();
    const transactor = makeTransactor(fx);

    await transactor.transact('a tracked write', async () => {
      await writeFile(join(fx.serverDir, 'Inbox', 'Beta.md'), '# Beta\n\nupdated\n');
    });

    const networkCalls = runGitSpy.mock.calls.filter(
      ([args]) => args[0] === 'fetch' || args[0] === 'push',
    );
    const localCalls = runGitSpy.mock.calls.filter(([args]) =>
      ['rev-parse', 'merge', 'add'].includes(args[0]!),
    );
    // Both kinds actually ran, so neither loop below is vacuously true.
    expect(networkCalls.some(([args]) => args[0] === 'fetch')).toBe(true);
    expect(networkCalls.some(([args]) => args[0] === 'push')).toBe(true);
    expect(localCalls.length).toBeGreaterThan(0);
    for (const [, , options] of networkCalls) {
      expect(options?.timeoutMs).toBeGreaterThan(30_000);
    }
    for (const [, , options] of localCalls) {
      expect(options?.timeoutMs).toBeUndefined();
    }
  });
});

describe('Transactor.readTransaction cross-process locking', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('refuses a read while another process holds the on-disk write lock', async () => {
    // The in-process enqueue mutex only serializes one Transactor's own operations; it
    // can't see a second process mutating the shared checkout. Simulate that peer by
    // planting the on-disk lockfile directly (as a concurrent cross-process transact()
    // would), then prove the read refuses rather than parsing a mid-transaction tree.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(lockPath, `pid ${process.pid}\n`);

    const transactor = makeTransactor(fx);
    let readRan = false;
    const err: unknown = await transactor
      .readTransaction(async () => {
        readRan = true;
        return 'unreachable';
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LockError);
    // The read body must never run while the peer holds the lock.
    expect(readRan).toBe(false);
    // A failed acquire must not unlink the peer's lockfile (that would let two writers
    // interleave), so the foreign lock is still present.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('releases the on-disk write lock when a read completes, so the next read can acquire it', async () => {
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    const transactor = makeTransactor(fx);

    const { result } = await transactor.readTransaction(async () => 'first');
    expect(result).toBe('first');
    // The lock must be gone once the read finishes, or every later operation deadlocks.
    expect(existsSync(lockPath)).toBe(false);
    // If the first read had leaked the lock, this second read's acquireLock would throw
    // LockError instead of returning cleanly.
    const second = await transactor.readTransaction(async () => 'second');
    expect(second.result).toBe('second');
  });
});

describe('Transactor.changedPaths rename parsing', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('parses a staged rename record as the target path only, not a mis-sliced orig-path fragment', async () => {
    // git status --porcelain=v1 -z pairs a rename/copy record across two NUL-separated
    // segments — the target path first, then a bare orig path with no "XY " status
    // prefix. Slicing every segment by a fixed 3-character offset mis-parses that bare
    // orig-path segment into a bogus "changed path" entry.
    await writeFile(
      join(fx.serverDir, 'Inbox', 'RenameSource.md'),
      '# Source\n\nSome body text.\n',
    );
    await git(['add', '-A'], fx.serverDir);
    await git(['commit', '-m', 'add rename source'], fx.serverDir);
    await git(['mv', 'Inbox/RenameSource.md', 'Inbox/RenameTarget.md'], fx.serverDir);

    const transactor = makeTransactor(fx);
    const changed = await transactor['changedPaths']();

    expect(changed).toEqual(['Inbox/RenameTarget.md']);
  });
});
