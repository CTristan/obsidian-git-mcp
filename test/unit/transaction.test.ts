import { existsSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import * as gitModule from '../../src/git.js';
import {
  HiddenIgnoredWriteError,
  IndeterminatePushError,
  LockError,
  Transactor,
  TransactionError,
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

  it('refuses to reconcile a checkout on a different branch', async () => {
    await git(['checkout', '-b', 'other'], fx.serverDir);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);

    const err: unknown = await makeTransactor(fx).reconcileAtStartup().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionError);
    expect((err as Error).message).toContain("checkout is on 'other'");
    expect(await git(['branch', '--show-current'], fx.serverDir)).toBe('other');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('refuses to reconcile a detached HEAD', async () => {
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    await git(['checkout', '--detach', preHead], fx.serverDir);

    const err: unknown = await makeTransactor(fx).reconcileAtStartup().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionError);
    expect((err as Error).message).toContain('detached HEAD');
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  });

  it('rejects option-like remote and branch configuration', () => {
    expect(() => makeTransactor(fx, { remote: '--upload-pack=probe' })).toThrow(TransactionError);
    expect(() => makeTransactor(fx, { branch: '-probe' })).toThrow(TransactionError);
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

  it('keeps a displaced live lock as reclaim debris when a third peer re-took the freed path before the link-back', async () => {
    // Extends the refuse-on-re-acquire race by one more contender. Our rename displaces peer C's
    // freshly-acquired live lock to claimPath and frees lockPath; a THIRD peer D then wins the
    // just-freed lockPath before our link-back can restore C's. link(claimPath, lockPath) fails
    // EEXIST, so claimPath is C's only surviving lock representation — unlinking it there would
    // leave C and D both believing they hold exclusive access (the cross-process mutual-exclusion
    // violation this module exists to prevent). A correct clear drops claimPath only when the
    // restore succeeds; here it must leave C's bytes as named .reclaim- debris and refuse.
    const actualFs = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    const deadPid = 999999;
    await writeFile(lockPath, `pid ${deadPid} at ${new Date().toISOString()}\n`);

    const cBytes = `pid ${process.pid} at ${new Date().toISOString()} peer-C\n`;
    const dBytes = `pid ${process.pid} at ${new Date().toISOString()} peer-D\n`;

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) {
        // Peer C re-acquires the moment the staleness snapshot is taken (live pid, new bytes),
        // so after the rename claimPath no longer matches the dead bytes we inspected.
        writeFileSync(lockPath, cBytes);
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    let claimPath: string | undefined;
    const renameSpy = vi.mocked(fsPromises.rename);
    renameSpy.mockImplementation((async (from: string, to: string) => {
      await actualFs.rename(from, to);
      if (from === lockPath) {
        // The rename freed lockPath; peer D wins it before the link-back can restore C's lock.
        claimPath = to;
        writeFileSync(lockPath, dBytes);
      }
    }) as unknown as typeof fsPromises.rename);

    try {
      const transactor = makeTransactor(fx);
      const err: unknown = await transactor['clearDeadLock']().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LockError);
      // D holds the canonical path untouched; C's displaced lock survives as reclaim debris.
      expect(existsSync(lockPath)).toBe(true);
      expect(await fsPromises.readFile(lockPath, 'utf8')).toBe(dBytes);
      expect(claimPath).toBeDefined();
      expect(existsSync(claimPath!)).toBe(true);
      expect(await fsPromises.readFile(claimPath!, 'utf8')).toBe(cBytes);
    } finally {
      killSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('publishes the lock atomically, so a torn pid write cannot leave reclaimable partial bytes at lockPath', async () => {
    // The replaced two-phase publish created the lockfile with open('wx') and wrote the pid on
    // a later await, so a short/torn write could leave non-empty partial bytes (a bare "pid "
    // prefix) at lockPath. clearDeadLock treats non-empty unparseable content as crash debris
    // and reclaims it — deleting a LIVE holder's lock and freeing reconcile to race its
    // transaction. Reproduce that torn write through the old open+handle seam; the atomic
    // publish never uses it (it writes a full temp file and hard-links it in), so lockPath
    // always carries this live process's complete pid and a peer clearDeadLock must refuse.
    const actualFs = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');

    vi.mocked(fsPromises.open).mockImplementation((async (path: string, ...args: unknown[]) => {
      const realOpen = actualFs.open as (p: string, ...a: unknown[]) => Promise<fsPromises.FileHandle>;
      const handle = await realOpen(path, ...args);
      if (path === lockPath) {
        handle.writeFile = (async () => {
          await actualFs.writeFile(lockPath, 'pid ');
        }) as typeof handle.writeFile;
      }
      return handle;
    }) as unknown as typeof fsPromises.open);

    try {
      await makeTransactor(fx)['acquireLock']();

      // The lock records this live process's complete pid, never a torn prefix.
      expect(await fsPromises.readFile(lockPath, 'utf8')).toContain(`pid ${process.pid}`);
      // Atomic publication writes a private staging path, never lockPath through the
      // old open-plus-write seam this mock would corrupt.
      expect(vi.mocked(fsPromises.open).mock.calls.some(([path]) => path === lockPath)).toBe(false);

      // A concurrent reclaimer sees a live holder and refuses, leaving the lock in place.
      const err: unknown = await makeTransactor(fx)['clearDeadLock']().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockError);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      vi.mocked(fsPromises.open).mockRestore();
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

  it('refuses to start on an empty lockfile instead of clearing it, since it carries no pid to prove its holder dead', async () => {
    // acquireLock publishes atomically (staging file + hard-link), so a correct holder's lock is
    // never empty. An empty file yields no parseable pid, so it cannot be proven dead — clearing
    // on "no pid" would delete a lock we cannot reason about. Only a provably-dead holder is safe
    // to clear; an unparseable pid must refuse, not clear.
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(lockPath, '');

    const transactor = makeTransactor(fx);
    const err: unknown = await transactor.reconcileAtStartup().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LockError);
    // The empty lock — no pid to prove it dead — must survive untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect(await fsPromises.readFile(lockPath, 'utf8')).toBe('');
  });

  it('clears a non-empty unparseable lockfile as crash debris, since a live holder never writes garbage', async () => {
    // acquireLock only ever links the complete serialized "pid N" payload, so non-empty
    // unparseable content is a process that crashed mid-write — dead debris that must never
    // block writes forever. It clears through the same safe rename-claim path a dead recorded
    // pid takes, and (unlike an empty lock) does not refuse: garbage is crash debris, not a
    // lock we must leave alone.
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

  it('refuses the whole transaction when tracked and already-ignored files change together', async () => {
    await fx.collabWrite('.gitignore', 'private/\n', 'collab: ignore private/');
    await git(['fetch', 'origin', 'main'], fx.serverDir);
    await git(['merge', '--ff-only', 'origin/main'], fx.serverDir);

    const ignoredDir = join(fx.serverDir, 'private');
    const ignoredPath = join(ignoredDir, 'notes.md');
    await mkdir(ignoredDir, { recursive: true });
    await writeFile(ignoredPath, '# Private\n\noriginal\n');

    const transactor = makeTransactor(fx);
    const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const preRemote = await git(['rev-parse', 'main'], fx.bareDir);
    const trackedPath = join(fx.serverDir, 'Inbox', 'Beta.md');
    const trackedBefore = await fsPromises.readFile(trackedPath, 'utf8');

    const err: unknown = await transactor
      .transact('tracked and already-ignored edits', async () => {
        await writeFile(trackedPath, '# Beta\n\nmutated body\n');
        await writeFile(ignoredPath, '# Private\n\nmutated\n');
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HiddenIgnoredWriteError);
    expect((err as Error).message.toLowerCase()).toContain('gitignore');
    expect(await git(['rev-parse', 'main'], fx.bareDir)).toBe(preRemote);
    expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
    expect(await fsPromises.readFile(trackedPath, 'utf8')).toBe(trackedBefore);
    // Existing ignored bytes remain outside git's rollback surface; #11 tracks the
    // separate snapshot-or-refusal design needed to restore them.
    expect(await fsPromises.readFile(ignoredPath, 'utf8')).toBe('# Private\n\nmutated\n');
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

describe('Transactor.recentChanges input normalization', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('clamps non-positive and non-finite limits to one commit', async () => {
    const transactor = makeTransactor(fx);
    for (const limit of [0, -10, Number.NaN]) {
      const lines = (await transactor.recentChanges(limit)).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Seed vault');
    }
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

  it('preserves the local commit when both push and verification fetch fail', async () => {
    const actual = await vi.importActual<typeof gitModule>('../../src/git.js');
    const runGitSpy = vi.mocked(gitModule.runGit);
    let pushFailed = false;
    runGitSpy.mockImplementation(async (args, cwd, options) => {
      if (args[0] === 'push') {
        pushFailed = true;
        throw new Error('push connection lost');
      }
      if (pushFailed && args[0] === 'fetch') {
        throw new Error('verification fetch unavailable');
      }
      return actual.runGit(args, cwd, options);
    });

    try {
      const err: unknown = await makeTransactor(fx)
        .transact('an indeterminate push', async () => {
          await writeFile(join(fx.serverDir, 'Inbox', 'Maybe.md'), '# Maybe\n');
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(IndeterminatePushError);
      expect((err as Error).message).toContain('whether the commit landed is unknown');
      expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
      expect(await git(['rev-list', '--count', 'origin/main..HEAD'], fx.serverDir)).toBe('1');
    } finally {
      runGitSpy.mockRestore();
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
