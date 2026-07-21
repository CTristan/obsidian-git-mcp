import { open, unlink } from 'node:fs/promises';
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

  private git(args: string[], options?: GitOptions): Promise<string> {
    return runGit(args, this.cfg.vaultPath, options);
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
    try {
      const handle = await open(this.lockPath, 'wx');
      await handle.writeFile(`pid ${process.pid} at ${new Date().toISOString()}\n`);
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LockError(
          `the vault write lock is already held (${this.lockPath}); ` +
            'remove the lockfile if its holder is dead',
        );
      }
      throw err;
    }
  }

  private async releaseLock(): Promise<void> {
    await unlink(this.lockPath).catch(() => {});
  }

  private async isDirty(): Promise<boolean> {
    return (await this.git(['status', '--porcelain'])) !== '';
  }

  private async changedPaths(): Promise<string[]> {
    // -z gives NUL-separated, unquoted paths. Unstaged changes never show as renames,
    // so every entry is a bare "XY path" record.
    const out = await this.git(['status', '--porcelain=v1', '-z']);
    return out
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3));
  }

  /**
   * Crash recovery, run once before serving. Uncommitted debris or an unpushed commit
   * means a transaction died before its push was acknowledged — safe to discard, because
   * the caller never received a SHA for it.
   */
  async reconcileAtStartup(): Promise<void> {
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

  /** Fetch + fast-forward when stale, then return HEAD. Reads ride the same mutex. */
  freshenForRead(): Promise<string> {
    return this.enqueue(async () => {
      if (Date.now() - this.lastFetchAt >= this.cfg.readFreshnessMs) {
        await this.git(['fetch', this.cfg.remote, this.cfg.branch]);
        this.lastFetchAt = Date.now();
        if (!(await this.isDirty())) {
          // A diverged checkout can't fast-forward; reads then serve the last consistent
          // state rather than failing, and the next write will surface the problem.
          await this.git(['merge', '--ff-only', this.target()]).catch(() => {});
        }
      }
      return this.git(['rev-parse', 'HEAD']);
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

        await mutate();

        const changed = await this.changedPaths();
        if (changed.length === 0) {
          return rollbackTo;
        }
        for (const relPath of changed) {
          await this.cfg.validateChangedFile(relPath);
        }

        await this.git(['add', '-A']);
        // Signing is forced off: an unattended service hanging on a key prompt is
        // strictly worse than an unsigned commit.
        await this.git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], {
          env: this.commitEnv(),
        });

        for (let attempt = 0; ; attempt++) {
          await this.cfg.beforePush?.();
          try {
            await this.git(['push', this.cfg.remote, `HEAD:${this.cfg.branch}`]);
            return await this.git(['rev-parse', 'HEAD']);
          } catch (err) {
            if (attempt >= this.cfg.maxPushRetries) {
              throw new ConflictError(
                `push failed after ${attempt + 1} attempts; nothing was changed: ${(err as Error).message}`,
              );
            }
            // The remote advanced under us. Rebasing our single commit is safe when it
            // applies cleanly; an actual conflict aborts and rolls the transaction back.
            await this.git(['fetch', this.cfg.remote, this.cfg.branch]);
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
          }
        }
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
    const ahead = Number(await this.git(['rev-list', '--count', `${this.target()}..HEAD`]));
    const behind = Number(await this.git(['rev-list', '--count', `HEAD..${this.target()}`]));
    return { headSha, branch: this.cfg.branch, dirty, ahead, behind };
  }

  async recentChanges(limit: number, path?: string): Promise<string> {
    const args = ['log', '--format=%h %an %ad %s', '--date=short', '-n', String(limit)];
    if (path !== undefined) {
      args.push('--', path);
    }
    return this.git(args);
  }
}
