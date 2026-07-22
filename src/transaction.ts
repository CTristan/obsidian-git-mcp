import { createHash } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, type GitOptions } from './git.js';

export class TransactionError extends Error {
  override name = 'TransactionError';
}

export class ConflictError extends TransactionError {
  override name = 'ConflictError';
}

export class LockError extends TransactionError {
  override name = 'LockError';
}

export class DirtyCheckoutError extends TransactionError {
  override name = 'DirtyCheckoutError';
}

export class HiddenIgnoredWriteError extends TransactionError {
  override name = 'HiddenIgnoredWriteError';
}

export interface Identity {
  name: string;
  email: string;
}

export interface TransactorConfig {
  vaultPath: string;
  branch: string;
  remote: string;
  collaborator: Identity;
  service: Identity;
  /** How stale a read may be before it triggers a fetch. */
  readFreshnessMs: number;
  /** Extra push attempts after a clean (non-conflicting) push race. */
  maxPushRetries: number;
  /** Called on every file a transaction changed, before commit. Throw to roll back. */
  validateChangedFile: (relPath: string) => Promise<void>;
  /** Test seam: runs before every push attempt. */
  beforePush?: (() => Promise<void>) | undefined;
  /** Test seam: runs after every git invocation resolves, before its result returns. */
  onGitCall?: ((args: readonly string[]) => void | Promise<void>) | undefined;
}

/**
 * Serializes every vault mutation into a git transaction: lock → clean check → fetch →
 * fast-forward → mutate → validate → commit → push → SHA. Any failure restores the
 * pre-transaction checkout, because a write that didn't reach the remote never happened.
 */
export class Transactor {
  private chain: Promise<unknown> = Promise.resolve();
  private lastFetchAt = 0;
  private readonly lockPath: string;

  constructor(private readonly cfg: TransactorConfig) {
    // Plain-clone assumption (no worktrees): the lock lives inside .git so it can never
    // sync to the remote or collide with a note path.
    this.lockPath = join(cfg.vaultPath, '.git', 'obsidian-git-mcp.lock');
  }

  private async git(args: string[], options?: GitOptions): Promise<string> {
    const result = await runGit(args, this.cfg.vaultPath, options);
    await this.cfg.onGitCall?.(args);
    return result;
  }

  /**
   * Fail fast when vaultPath isn't a git checkout — everything a Transactor does assumes
   * one. Static because it must run before construction, but it keeps this the only seam
   * that touches git, matching every other invocation's route through the private git().
   */
  static async assertCheckout(vaultPath: string): Promise<void> {
    await runGit(['rev-parse', '--git-dir'], vaultPath);
  }

  private target(): string {
    return `${this.cfg.remote}/${this.cfg.branch}`;
  }

  private commitEnv(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: this.cfg.collaborator.name,
      GIT_AUTHOR_EMAIL: this.cfg.collaborator.email,
      GIT_COMMITTER_NAME: this.cfg.service.name,
      GIT_COMMITTER_EMAIL: this.cfg.service.email,
    };
  }

  /** Promise-chain mutex: one vault operation at a time, errors don't break the chain. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async acquireLock(): Promise<void> {
    let handle;
    try {
      handle = await open(this.lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LockError(
          `the vault write lock is already held (${this.lockPath}); ` +
            'remove the lockfile if its holder is dead',
        );
      }
      throw err;
    }
    // The lockfile already exists on disk here, so a failure writing or closing must
    // remove it — otherwise the orphan blocks every write until the next restart.
    try {
      await handle.writeFile(`pid ${process.pid} at ${new Date().toISOString()}\n`);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(this.lockPath).catch(() => {});
      throw err;
    }
  }

  private async releaseLock(): Promise<void> {
    await unlink(this.lockPath).catch((err) => {
      // A missing lockfile is fine (already released); anything else deserves a trace,
      // because a lock that silently fails to release blocks every later write.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`failed to release the vault lock at ${this.lockPath}:`, err);
      }
    });
  }

  /**
   * Remove a leftover lockfile only when its recorded holder is dead. A live pid means
   * another server is actively writing this checkout (e.g. a rolling restart overlap) —
   * ripping its lock out and resetting the tree would corrupt that transaction, so we
   * refuse to start instead.
   */
  private async releaseStaleLock(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    // Our own pid counts as live too: a lockfile with this process's pid means another
    // Transactor in this same process holds it (the lockfile, not the in-process mutex,
    // is what separates two Transactors on one checkout).
    const pid = Number(contents.match(/^pid (\d+)/)?.[1]);
    if (pid && this.isProcessAlive(pid)) {
      throw new LockError(
        `the vault lock at ${this.lockPath} is held by live pid ${pid}; refusing to start`,
      );
    }
    await this.releaseLock();
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the pid exists but belongs to another user/permission domain — still
      // alive, so keep refusing rather than clearing a live holder's lock. Only ESRCH
      // (no such process) means dead.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async isDirty(): Promise<boolean> {
    // --no-optional-locks: status() runs outside the mutex, and a plain `git status`
    // opportunistically rewrites .git/index — which can collide with a concurrent
    // transaction's index.lock and spuriously fail one side.
    return (await this.git(['--no-optional-locks', 'status', '--porcelain'])) !== '';
  }

  private async changedPaths(): Promise<string[]> {
    // -z gives NUL-separated, unquoted paths. Unstaged changes never show as renames,
    // so every entry is a bare "XY path" record.
    const out = await this.git(['--no-optional-locks', 'status', '--porcelain=v1', '-z']);
    return out
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3));
  }

  /**
   * Individual gitignored files currently present, recursing into a wholly-ignored
   * directory instead of collapsing it to one entry the way plain `git status` does —
   * needed to validate each newly-ignored note on its own and to fingerprint the paths
   * that were already ignored before the transaction started (see ignoredFingerprint()).
   * Plain `git status` skips ignored paths entirely, so a vault that gitignores
   * .obsidian/ (common, since Obsidian's own workspace/cache files are routinely
   * excluded) would hide a restricted write from changedPaths() forever. Callers must
   * diff this against a pre-mutation snapshot: a path that's already ignored before the
   * transaction started must not fail every later write too, since it would then never
   * clear again.
   */
  private async ignoredFiles(): Promise<string[]> {
    const out = await this.git([
      '--no-optional-locks',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ]);
    return out.split('\0').filter((entry) => entry.length > 0);
  }

  /**
   * Change signal for a fixed set of paths, order-independent. Git status can never
   * reveal a content-only edit to a path that's already ignored (ignored paths are
   * invisible to it, not merely excluded from one output), so the only way to notice a
   * mutation that only touched already-ignored files is to compare them ourselves before
   * and after. Fingerprints by stat (size + mtimeMs) rather than by content: a vault that
   * gitignores .obsidian/ can hold multi-MB plugin/workspace/cache data, and this digest
   * runs on every transact(), so hashing full file contents would scale write latency to
   * the size of that tree. A content rewrite always updates mtime (and usually size), so
   * this still catches the hidden-write case; the accepted trade-off is a same-size,
   * same-mtimeMs content swap landing within one stat call of the original, which a full
   * content hash would catch but only by paying that read on every single write.
   */
  private async ignoredFingerprint(relPaths: readonly string[]): Promise<string> {
    const hash = createHash('sha1');
    for (const relPath of [...relPaths].sort()) {
      hash.update(relPath).update('\0');
      try {
        const stats = await lstat(join(this.cfg.vaultPath, relPath));
        hash.update(`${stats.size}\0${stats.mtimeMs}`);
      } catch {
        // Vanished since being listed; its absence is still folded into the digest via
        // the path-only update above, so a delete-then-recreate still changes the hash.
      }
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  /** Paths our current HEAD touches relative to `ref` — the committed analog of changedPaths(). */
  private async changedPathsSince(ref: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', '-z', ref, 'HEAD']);
    return out.split('\0').filter((entry) => entry.length > 0);
  }

  /**
   * Crash recovery, run once before serving. Uncommitted debris or an unpushed commit
   * means a transaction died before its push was acknowledged — safe to discard, because
   * the caller never received a SHA for it.
   */
  async reconcileAtStartup(): Promise<void> {
    // A crashed process can't release its lock, and the lock lives in .git/ where tree
    // recovery never looks — but only a DEAD holder's lock is safe to clear.
    await this.releaseStaleLock();
    await this.git(['fetch', this.cfg.remote, this.cfg.branch]);
    this.lastFetchAt = Date.now();
    const unpushed = (await this.git(['rev-list', `${this.target()}..HEAD`])) !== '';
    if ((await this.isDirty()) || unpushed) {
      await this.git(['rebase', '--abort']).catch(() => {});
      await this.git(['reset', '--hard', this.target()]);
      await this.git(['clean', '-fd']);
    } else {
      await this.git(['merge', '--ff-only', this.target()]);
    }
  }

  /**
   * Run a read inside the mutex — the freshen step AND the read itself — so a read can
   * never observe another transaction's mid-mutation or mid-rollback tree state. The
   * returned headSha is captured in the same critical section the read ran in.
   */
  readTransaction<T>(read: () => Promise<T>): Promise<{ headSha: string; result: T }> {
    return this.enqueue(async () => {
      if (Date.now() - this.lastFetchAt >= this.cfg.readFreshnessMs) {
        // A transient remote outage degrades reads to last-known state instead of
        // failing them (writes stay strict — their own fetch is unguarded). The
        // timestamp advances even on failure so an outage doesn't stall every read
        // behind a fetch timeout.
        await this.git(['fetch', this.cfg.remote, this.cfg.branch]).catch(() => {});
        this.lastFetchAt = Date.now();
        if (!(await this.isDirty())) {
          // A diverged checkout can't fast-forward; reads then serve the last consistent
          // state rather than failing, and the next write will surface the problem.
          await this.git(['merge', '--ff-only', this.target()]).catch(() => {});
        }
      }
      const headSha = await this.git(['rev-parse', 'HEAD']);
      const result = await read();
      return { headSha, result };
    });
  }

  /** Run one mutation as a full transaction. Returns the pushed commit SHA. */
  transact(message: string, mutate: () => Promise<void>): Promise<string> {
    return this.enqueue(async () => {
      // acquireLock sits outside the try: a failed acquire must never reach the finally,
      // because unlinking a foreign process's lockfile would let two writers interleave.
      await this.acquireLock();
      let rollbackTo: string | undefined;
      try {
        if (await this.isDirty()) {
          throw new DirtyCheckoutError(
            'the checkout is dirty; refusing to write (restart the server to reconcile)',
          );
        }
        await this.git(['fetch', this.cfg.remote, this.cfg.branch]);
        this.lastFetchAt = Date.now();
        await this.git(['merge', '--ff-only', this.target()]);
        rollbackTo = await this.git(['rev-parse', 'HEAD']);
        const ignoredBefore = await this.ignoredFiles();
        const ignoredBeforeFingerprint = await this.ignoredFingerprint(ignoredBefore);

        await mutate();

        const changed = await this.changedPaths();
        const ignoredBeforeSet = new Set(ignoredBefore);
        const newlyIgnored = (await this.ignoredFiles()).filter(
          (path) => !ignoredBeforeSet.has(path),
        );
        const toValidate = [...changed, ...newlyIgnored];
        if (toValidate.length === 0) {
          if ((await this.ignoredFingerprint(ignoredBefore)) !== ignoredBeforeFingerprint) {
            // git can neither stage nor commit an already-ignored path, so there is no
            // safe way to land this edit — only to refuse it and say so, instead of
            // reporting the untouched HEAD as a successful write.
            throw new HiddenIgnoredWriteError(
              'the mutation only touched an already-gitignored path, which git cannot ' +
                'stage or commit; refusing to report success for an untracked write',
            );
          }
          return rollbackTo;
        }
        for (const relPath of toValidate) {
          await this.cfg.validateChangedFile(relPath);
        }

        await this.git(['add', '-A']);
        // Signing is forced off: an unattended service hanging on a key prompt is
        // strictly worse than an unsigned commit.
        await this.git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], {
          env: this.commitEnv(),
        });

        return await this.pushWithRetries();
      } catch (err) {
        if (rollbackTo !== undefined) {
          await this.git(['rebase', '--abort']).catch(() => {});
          await this.git(['reset', '--hard', rollbackTo]).catch(() => {});
          await this.git(['clean', '-fd']).catch(() => {});
        }
        throw err;
      } finally {
        await this.releaseLock();
      }
    });
  }

  /**
   * Push the just-committed HEAD, retrying through a bounded number of rebase-onto-remote
   * attempts when the remote advances underneath us. Returns the pushed SHA; throws
   * ConflictError once retries are exhausted or a concurrent edit doesn't reconcile.
   */
  private async pushWithRetries(): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.cfg.beforePush?.();
      try {
        await this.git(['push', this.cfg.remote, `HEAD:${this.cfg.branch}`]);
        return await this.git(['rev-parse', 'HEAD']);
      } catch (err) {
        // A failed push may still have landed: the remote can update the ref and
        // the ACK get lost afterwards, so check reachability before treating this
        // as a failure — otherwise we'd roll back and report "nothing was changed"
        // for a write that IS on the remote, and the caller's retry would duplicate it.
        await this.git(['fetch', this.cfg.remote, this.cfg.branch]);
        this.lastFetchAt = Date.now();
        const landed = await this.git([
          'merge-base',
          '--is-ancestor',
          'HEAD',
          this.target(),
        ]).then(
          () => true,
          () => false,
        );
        if (landed) {
          return await this.git(['rev-parse', 'HEAD']);
        }
        if (attempt >= this.cfg.maxPushRetries) {
          throw new ConflictError(
            `push failed after ${attempt + 1} attempts; nothing was changed: ${(err as Error).message}`,
          );
        }
        // The remote advanced under us. Rebasing our single commit is safe when it
        // applies cleanly; an actual conflict aborts and rolls the transaction back.
        try {
          await this.git(['-c', 'commit.gpgsign=false', 'rebase', this.target()], {
            env: this.commitEnv(),
          });
        } catch (rebaseErr) {
          await this.git(['rebase', '--abort']).catch(() => {});
          throw new ConflictError(
            'a concurrent edit conflicts with this write; nothing was changed: ' +
              (rebaseErr as Error).message,
          );
        }

        // A clean rebase is a line-based three-way merge, not a semantic one: it can
        // silently splice a non-overlapping concurrent edit — never itself validated
        // by this server — into the file we're about to push. Re-check every path the
        // rebased commit touches before retrying the push.
        for (const relPath of await this.changedPathsSince(this.target())) {
          try {
            await this.cfg.validateChangedFile(relPath);
          } catch (validateErr) {
            throw new ConflictError(
              'a concurrent edit conflicts with this write (rebased content failed ' +
                `validation); nothing was changed: ${(validateErr as Error).message}`,
            );
          }
        }
      }
    }
  }

  /** Cheap, lock-free repository status for vault_status. */
  async status(): Promise<{
    headSha: string;
    branch: string;
    dirty: boolean;
    ahead: number;
    behind: number;
  }> {
    const headSha = await this.git(['rev-parse', 'HEAD']);
    const dirty = await this.isDirty();
    // Reuse the captured headSha rather than the literal ref `HEAD`, which a concurrent
    // transact() could have advanced by now — otherwise ahead/behind would describe a
    // different commit than the headSha in the same returned snapshot.
    const counts = await this.git([
      'rev-list',
      '--left-right',
      '--count',
      `${this.target()}...${headSha}`,
    ]);
    // `A...B` left-right counts are tab-separated as "<only-in-A>\t<only-in-B>", i.e.
    // behind (commits target has that headSha lacks) then ahead (the reverse).
    const [behind, ahead] = counts.split('\t').map(Number);
    return { headSha, branch: this.cfg.branch, dirty, ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  async recentChanges(limit: number, path?: string): Promise<string> {
    const args = ['log', '--format=%h %an %ad %s', '--date=short', '-n', String(limit)];
    if (path !== undefined) {
      args.push('--', path);
    }
    return this.git(args);
  }
}
