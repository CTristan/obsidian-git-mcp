import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import {
  createGitExecutionCache,
  GitError,
  invalidateGitExecutionCache,
  runGit,
  type GitOptions,
} from './git.js';

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

export class IndeterminatePushError extends TransactionError {
  override name = 'IndeterminatePushError';
}

export interface Identity {
  name: string;
  email: string;
}

/**
 * Server composition details for the internal transaction primitive.
 *
 * @internal
 */
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
  /**
   * Called on every note a fetch/fast-forward newly landed, before any read is served.
   * Throw to refuse the read outright — unlike validateChangedFile, there is no local
   * mutation to roll back here, only remote content this process didn't write.
   */
  refuseExecutableNote: (relPath: string) => Promise<void>;
  /** Test seam: runs before every push attempt. */
  beforePush?: (() => Promise<void>) | undefined;
  /** Test seam: runs after every git invocation settles, before its result or error returns. */
  onGitCall?: ((args: readonly string[]) => void | Promise<void>) | undefined;
}

/**
 * Cap on how many refuseExecutableNote calls refuseUnvalidatedFetchedNotes runs at once
 * during a full-vault scan. A "second brain" vault can hold thousands of notes, and each
 * call does a readFile plus a gray-matter parse, so firing every note at once would starve
 * libuv's threadpool the same way an uncapped manifestOf walk would (see staging.ts's
 * DIR_CONCURRENCY) — this bounds the parallelism instead of scanning one note at a time.
 */
const SCAN_CONCURRENCY = 64;

/**
 * Cap on how many ignored paths ignoredFingerprint() lstats at once. A vault that
 * gitignores .obsidian/ can hold thousands of plugin/workspace/cache files, and this runs
 * on every transact(), so an uncapped Promise.all here would fire that whole tree's lstat
 * calls in one burst — the same threadpool/EMFILE starvation SCAN_CONCURRENCY and
 * staging.ts's DIR_CONCURRENCY bound against.
 */
const FINGERPRINT_CONCURRENCY = 64;

/**
 * Timeout for the git commands that talk to the remote — fetch and push. runGit defaults
 * every command to a 30s ceiling, which fits fast local plumbing but not network I/O: a
 * fetch or push against a large "second brain" vault or a slow remote can legitimately run
 * for minutes, and a 30s kill there fails an otherwise-healthy write and forces a needless
 * rollback. Local plumbing (status, rev-parse, merge, rebase, commit) keeps the 30s
 * default, because a hang there means something is genuinely wrong rather than merely slow.
 *
 * Operator note: this ceiling is per network command, and pushWithRetries can run several
 * against a hung remote in one transact() — with maxPushRetries at its default of 2 that's
 * up to 3 push attempts plus a post-failure fetch after each, so a truly wedged remote can
 * hold a single tool call for ~30 minutes before it gives up and rolls back. Size the MCP
 * client's tool-call timeout above that worst case, because a client that times out first
 * reports a spurious failure to the caller while the transaction is still rolling back.
 */
const NETWORK_GIT_TIMEOUT_MS = 300_000;

/**
 * The vault lockfile records its holder's pid so clearDeadLock can tell a live
 * cross-process holder (refuse to start) from a crash-orphaned one (safe to clear). The
 * writer and parser below share this prefix because a desync between them is silently
 * catastrophic: if the parser stopped matching the write format, clearDeadLock would
 * read no pid, treat a live holder as dead, and clear its lock — letting a concurrent
 * cross-process transaction corrupt the shared checkout.
 */
const LOCK_PID_PREFIX = 'pid ';

/**
 * How many times acquireLockClearingStale re-attempts the atomic acquire after clearing a
 * dead lock before giving up. Each clear→acquire round can lose the race to a concurrent
 * startup that acquires first, but a live winner makes the next clear refuse outright, so
 * this bound only guards against pathological churn (a dead lock repeatedly re-planted)
 * rather than a real deadlock — a small ceiling suffices, and exceeding it means something
 * is wrong with the checkout, so refuse to start rather than spin.
 */
const STALE_RECLAIM_ATTEMPTS = 10;

function serializeLock(pid: number): string {
  return `${LOCK_PID_PREFIX}${pid} at ${new Date().toISOString()}\n`;
}

function parseLockPid(contents: string): number | undefined {
  if (!contents.startsWith(LOCK_PID_PREFIX)) return undefined;
  const pid = Number.parseInt(contents.slice(LOCK_PID_PREFIX.length), 10);
  // A non-positive pid never comes from serializeLock (Node's process.pid is always positive),
  // so it's corruption, not a holder. Rejecting it here routes such a lock into the non-empty-
  // garbage → clear branch, because feeding a non-positive value to process.kill(pid, 0) targets
  // a process GROUP that answers "alive" unconditionally — deadlocking crash recovery forever.
  return Number.isNaN(pid) || pid <= 0 ? undefined : pid;
}

function assertSafeGitName(kind: 'remote' | 'branch', value: string): void {
  const unsafe =
    value === '' ||
    value.startsWith('-') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    /[\x00-\x20\x7f~^:?*[\]\\]/.test(value) ||
    value.split('/').some((segment) => segment.endsWith('.lock'));
  if (unsafe) {
    throw new TransactionError(`invalid git ${kind} name: ${JSON.stringify(value)}`);
  }
}

function assertSafeIdentity(kind: 'collaborator' | 'service', identity: Identity): void {
  if (identity.name === '' || /[<>\r\n]/.test(identity.name)) {
    throw new TransactionError(`invalid ${kind} git identity name`);
  }
  if (identity.email === '' || /[<>\r\n]/.test(identity.email)) {
    throw new TransactionError(`invalid ${kind} git identity email`);
  }
}

/**
 * Serializes every vault mutation into a git transaction: lock → clean check → fetch →
 * fast-forward → mutate → validate → commit → push → SHA.
 *
 * Supported server adapters must resolve their complete concrete mutation set and call
 * `refuseIgnoredPaths()` immediately before the callback touches live content. Once the
 * callback stays inside git's writable surface, a failure restores the pre-transaction
 * checkout because a write that did not reach the remote never happened.
 *
 * `ignoredFingerprint()` only diagnoses a breach of that preflight invariant after live
 * mutation. It cannot restore pre-existing ignored bytes, so arbitrary direct callbacks
 * outside the server adapters are unsupported.
 *
 * @internal
 */
export class Transactor {
  private chain: Promise<unknown> = Promise.resolve();
  private lastFetchAt = 0;
  private readonly lockPath: string;
  private readonly gitExecutionCache = createGitExecutionCache();
  // The HEAD through which every note has already cleared refuseExecutableNote. undefined
  // until reconcileAtStartup's first pass; readTransaction advances it after each scan.
  private validatedThroughSha: string | undefined;

  constructor(private readonly cfg: TransactorConfig) {
    assertSafeGitName('remote', cfg.remote);
    assertSafeGitName('branch', cfg.branch);
    assertSafeIdentity('collaborator', cfg.collaborator);
    assertSafeIdentity('service', cfg.service);
    // Plain-clone assumption (no worktrees): the lock lives inside .git so it can never
    // sync to the remote or collide with a note path.
    this.lockPath = join(cfg.vaultPath, '.git', 'obsidian-git-mcp.lock');
  }

  private async git(args: string[], options?: GitOptions): Promise<string> {
    try {
      return await runGit(args, this.cfg.vaultPath, {
        ...options,
        executionCache: this.gitExecutionCache,
      });
    } finally {
      await this.cfg.onGitCall?.(args);
    }
  }

  private invalidateGitExecutionConfig(): void {
    invalidateGitExecutionCache(this.gitExecutionCache);
  }

  private async gitChangingWorktree(args: string[], options?: GitOptions): Promise<string> {
    try {
      return await this.git(args, options);
    } finally {
      // A successful or partial worktree change can expose a different included Git config.
      // Clear the scan before any later command can execute a newly selected filter or diff.
      this.invalidateGitExecutionConfig();
    }
  }

  private async fetchRemote(): Promise<void> {
    try {
      await this.git(['fetch', '--', this.cfg.remote, this.cfg.branch], {
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      });
    } finally {
      // A config file can change while a network operation runs, including one that fails.
      // Force the next command to rescan before it trusts execution-capable Git settings.
      this.invalidateGitExecutionConfig();
    }
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
    // Publish the lock atomically. Writing the pid to a private staging file and hard-linking
    // it onto lockPath means the lockfile, the instant it is visible, already holds the complete
    // payload — never the empty or torn-write bytes a two-phase open('wx')-then-write exposes,
    // which a peer's clearDeadLock could misread as crash debris and reclaim from a live holder.
    // link() keeps open('wx')'s fail-if-exists guarantee: it throws EEXIST rather than clobbering
    // a lock another process already holds. The staging file lives beside lockPath in .git, on
    // the same filesystem link() requires, and is never synced or read as a lock.
    const stagePath = `${this.lockPath}.acquire-${randomUUID()}`;
    try {
      await writeFile(stagePath, serializeLock(process.pid));
    } catch (err) {
      await unlink(stagePath).catch(() => {});
      throw err;
    }
    try {
      await link(stagePath, this.lockPath);
    } catch (err) {
      await unlink(stagePath).catch(() => {});
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LockError(
          `the vault write lock is already held (${this.lockPath}); ` +
            'remove the lockfile if its holder is dead',
        );
      }
      throw err;
    }
    // The link succeeded, so lockPath now points at the staged inode; drop the staging name,
    // leaving the single lockPath hard link as the live lock.
    await unlink(stagePath).catch(() => {});
  }

  /**
   * Acquire the write lock at startup, clearing a provably-dead holder's stale lock as part
   * of acquisition. Clearing and taking the lock in one loop leaves no window where the lock
   * is free but unowned — the gap a separate clear-then-acquire opens, which a peer startup
   * (a rolling-restart overlap) could slip through to race reconcile's fetch/reset/clean/merge
   * on the shared worktree. acquireLock is the atomic gate: it hard-links its fully-written pid
   * file onto lockPath, and link admits exactly one creator (it throws EEXIST if the path already
   * exists), so two processes can never both hold the lock. clearDeadLock only removes a lock
   * it can prove dead and refuses on a live holder (or a lock it cannot prove dead), so a lost
   * race to a concurrent startup just re-enters the loop, where the now-live winner makes clearDeadLock
   * refuse. The attempt cap turns pathological churn (a dead lock repeatedly re-planted) into
   * a refusal rather than an unbounded spin.
   */
  private async acquireLockClearingStale(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.acquireLock();
        return;
      } catch (err) {
        if (!(err instanceof LockError)) throw err;
        if (attempt >= STALE_RECLAIM_ATTEMPTS) {
          throw new LockError(
            `the vault lock at ${this.lockPath} kept being re-taken by concurrent startups ` +
              `across ${attempt} reclaim attempts; refusing to start`,
          );
        }
      }
      // Reached only when acquireLock found an existing lock. clearDeadLock throws (refuse)
      // for a live holder or a lock it cannot prove dead, or returns once a provably-dead lock
      // is cleared — then the loop re-attempts the atomic acquire.
      await this.clearDeadLock();
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
   * Clear a leftover lockfile only when its recorded holder is provably dead, leaving the
   * path free for acquireLockClearingStale's next acquire. Refuses (throws LockError) when
   * the holder is alive — another server is actively writing this checkout (a rolling-restart
   * overlap), and ripping its lock out to reset the tree would corrupt that transaction.
   *
   * A live pid is not the only outcome; the two no-pid cases split by content. Because acquireLock
   * publishes atomically — it writes the full "pid N" payload to a staging file, then hard-links
   * it onto lockPath — a correct holder's lock is never observable empty or half-written. So an
   * EMPTY lock ('') is not a mid-acquire holder but externally-created or crash-orphaned debris
   * with no pid to prove its holder dead; refuse rather than guess. A NON-EMPTY unparseable lock
   * (e.g. "crashed mid-write") is crash debris: a live acquirer only ever links the complete
   * "pid N" payload, never garbage, so a garbage inode races nobody and clears safely — and a
   * crashed holder's lock must never block writes forever.
   *
   * The clear is a claim, not a blind unlink. A path unlink races a peer that re-acquired
   * between the liveness read and the removal — it would delete the peer's fresh live lock,
   * the exact corruption the pid check exists to prevent. Instead we rename the inspected
   * inode to a private path: rename is atomic, so only one racing reclaimer moves a given
   * inode, and we then confirm the bytes we moved are still the dead lock we inspected. If
   * they changed, a peer re-acquired in the gap and we displaced their live lock, so we put
   * it back (link, which won't clobber a lock a newer acquire has since created) and refuse.
   */
  private async clearDeadLock(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.lockPath, 'utf8');
    } catch (err) {
      // Vanished — a peer already cleared it; nothing to clear, let the caller retry acquire.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (contents === '') {
      // Empty: acquireLock publishes atomically (staging file + hard-link), so a correct holder's
      // lock is never empty. An empty file therefore carries no pid to prove its holder dead, and
      // clearing on "no pid" could delete a lock we cannot reason about — refuse rather than guess.
      // Name the path so an operator can remove genuinely-orphaned empty debris by hand.
      throw new LockError(
        `the vault lock at ${this.lockPath} is empty — it carries no holder pid to prove it dead; ` +
          'refusing to start. Remove it manually only if it is orphaned debris.',
      );
    }
    // Our own pid counts as live too: a lockfile with this process's pid means another
    // Transactor in this same process holds it (the lockfile, not the in-process mutex,
    // is what separates two Transactors on one checkout).
    const pid = parseLockPid(contents);
    if (pid !== undefined && this.isProcessAlive(pid)) {
      throw new LockError(
        `the vault lock at ${this.lockPath} is held by live pid ${pid}; refusing to start`,
      );
    }
    // A dead recorded pid, or non-empty unparseable crash debris — both are safe to clear, and
    // a crashed holder's lock must never block writes forever. Claim the inode with an atomic
    // rename (only one racer moves a given inode), then confirm the bytes we moved are the ones
    // we inspected; a live acquirer's payload is always the serialized "pid N", never garbage,
    // so this claim races nobody except a peer that re-acquired in the read→rename gap.
    const claimPath = `${this.lockPath}.reclaim-${randomUUID()}`;
    try {
      await rename(this.lockPath, claimPath);
    } catch (err) {
      // Another reclaimer won the rename; the path is already clear, let the caller retry.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const claimed = await readFile(claimPath, 'utf8').catch(() => '');
    if (claimed !== contents) {
      // The bytes changed under us: a peer re-acquired between our read and the rename, so we
      // moved their live lock. Restore it to the canonical path (link won't clobber a lock a
      // newer acquire has since created there) and refuse, exactly as the live-pid check does.
      // Only drop our private copy when that restore succeeds: a failed link means a third peer
      // re-took lockPath in the gap, so claimPath now holds the displaced peer's only lock bytes,
      // and unlinking it would leave that peer and the new lockPath holder both believing they
      // hold exclusive access. Leave those bytes as named .reclaim- debris instead — safe to
      // clear only once they are no longer a live peer's lock.
      const restored = await link(claimPath, this.lockPath).then(
        () => true,
        () => false,
      );
      if (restored) await unlink(claimPath).catch(() => {});
      throw new LockError(
        `the vault lock at ${this.lockPath} was re-acquired while being cleared; refusing to start`,
      );
    }
    // Byte-identical to the dead lock we inspected: drop our private copy, freeing the path
    // for the caller's next acquire.
    await unlink(claimPath).catch(() => {});
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
    // -z gives NUL-separated, unquoted paths. --untracked-files=all is load-bearing:
    // without it git collapses a new note's new parent directory to "NewFolder/", so
    // validateChangedFile would see a directory instead of the note and skip its content
    // checks — a delegated write to a fresh folder would then commit unvalidated.
    // A rename or copy record (status code containing 'R' or 'C') is split across two
    // NUL-separated segments in -z output: the target path first, then a bare orig path
    // with no "XY " status prefix — git-status(1) calls this "the field order is
    // reversed" versus the space-separated format. That orig-path segment must be
    // consumed as the record's pair, not sliced as its own bogus entry.
    const out = await this.git([
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '-z',
    ]);
    // length > 0, not > 3: a paired orig-path continuation segment has no "XY " prefix,
    // so a short filename there (1-3 chars) would otherwise be dropped and desync the
    // pairing below. Every non-paired record is always >= 4 chars ("XY " plus a filename
    // character), so this admits nothing a stricter filter wouldn't already have kept.
    const entries = out.split('\0').filter((entry) => entry.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const status = entry.slice(0, 2);
      paths.push(entry.slice(3));
      if (status.includes('R') || status.includes('C')) {
        i++; // skip the paired orig-path segment
      }
    }
    return paths;
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
    if (relPaths.length === 0) return '';
    const sorted = [...relPaths].sort();
    // FINGERPRINT_CONCURRENCY caps the fan-out the way manifestOf and the note scan do;
    // mapWithConcurrency preserves input order, so stats[index] still lines up with sorted.
    const stats = await mapWithConcurrency(sorted, FINGERPRINT_CONCURRENCY, (relPath) =>
      lstat(join(this.cfg.vaultPath, relPath)).catch(() => undefined),
    );
    const hash = createHash('sha256');
    for (const [index, relPath] of sorted.entries()) {
      hash.update(relPath).update('\0');
      const stat = stats[index];
      if (stat) {
        hash.update(`${stat.size}\0${stat.mtimeMs}`);
      } else {
        // Vanished since being listed; its absence is still folded into the digest via
        // the path-only update above, so a delete-then-recreate still changes the hash.
      }
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  async refuseIgnoredPaths(relPaths: readonly string[]): Promise<void> {
    const candidates = [...new Set(relPaths)].filter((relPath) => relPath !== '');
    if (candidates.length === 0) return;
    let ignored: string[];
    try {
      const out = await this.git(['check-ignore', '--', ...candidates]);
      ignored = out.split(/\r?\n/).filter((relPath) => relPath !== '');
    } catch (err) {
      // check-ignore exits 1 with no stderr when none of the candidate paths are ignored.
      if (!(err instanceof GitError) || err.exitCode !== 1 || err.stderr !== '') throw err;
      return;
    }
    if (ignored.length > 0) {
      throw new HiddenIgnoredWriteError(
        `the mutation targets gitignored path(s) [${ignored.join(', ')}] that git can ` +
          'neither stage nor commit; refusing before the live vault is changed',
      );
    }
  }

  /** Paths our current HEAD touches relative to `ref` — the committed analog of changedPaths(). */
  private async changedPathsSince(ref: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', '-z', ref, 'HEAD']);
    return out.split('\0').filter((entry) => entry.length > 0);
  }

  /**
   * Refuses to let a read proceed until every note reachable from the current HEAD has
   * been checked by refuseExecutableNote — not just whatever this call's own fetch just
   * landed. transact()'s mandatory fetch can advance HEAD without ever routing through
   * here, so the gap this closes is "HEAD moved since we last scanned," not "did this
   * particular call just fetch." First run (validatedThroughSha undefined) scans every
   * tracked file; later runs scan only the diff, since anything at or before
   * validatedThroughSha already cleared this same check.
   */
  private async refuseUnvalidatedFetchedNotes(): Promise<void> {
    const head = await this.git(['rev-parse', 'HEAD']);
    if (head === this.validatedThroughSha) return;
    const paths =
      this.validatedThroughSha === undefined
        ? (await this.git(['ls-files', '-z'])).split('\0').filter((entry) => entry.length > 0)
        : await this.changedPathsSince(this.validatedThroughSha);
    // Each note's refusal is independent of every other's, so run them through
    // mapWithConcurrency instead of awaiting one at a time — the SCAN_CONCURRENCY cap still
    // rejects (and aborts the scan) the moment any note throws, matching the serial loop's
    // fail-fast semantics.
    await mapWithConcurrency(paths, SCAN_CONCURRENCY, (relPath) =>
      this.cfg.refuseExecutableNote(relPath),
    );
    this.validatedThroughSha = head;
  }

  /**
   * Crash recovery, run once before serving. Uncommitted debris or an unpushed commit
   * means a transaction died before its push was acknowledged — safe to discard, because
   * the caller never received a SHA for it.
   */
  async reconcileAtStartup(): Promise<void> {
    this.invalidateGitExecutionConfig();
    // A crashed process can't release its lock, and the lock lives in .git/ where tree
    // recovery never looks — but only a DEAD holder's lock is safe to clear. Clear it and
    // take our own lock in one atomic loop: a separate clear-then-acquire leaves a window
    // where the lock is free but unowned, and a peer process (a rolling-restart overlap) could
    // slip into transact() through it and race these fetch/reset/clean/merge mutations on the
    // shared worktree. The acquire sits outside the try (same invariant as transact() and
    // readTransaction()): a failed or refused acquire must never reach the finally that
    // unlinks the lockfile, because that would unlink a live peer's lock.
    await this.acquireLockClearingStale();
    try {
      const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
        () => '',
      );
      if (current !== this.cfg.branch) {
        throw new TransactionError(
          `the checkout is on '${current || 'a detached HEAD'}' but the server is configured ` +
            `for branch '${this.cfg.branch}'; refusing to start`,
        );
      }
      await this.fetchRemote();
      this.lastFetchAt = Date.now();
      const unpushed = (await this.git(['rev-list', `${this.target()}..HEAD`])) !== '';
      if ((await this.isDirty()) || unpushed) {
        await this.gitChangingWorktree(['rebase', '--abort']).catch(() => {});
        await this.gitChangingWorktree(['reset', '--hard', this.target()]);
        await this.gitChangingWorktree(['clean', '-fd']);
      } else {
        await this.gitChangingWorktree(['merge', '--ff-only', this.target()]);
      }
      // Establishes the baseline before this process ever serves a read — a vault that
      // already carries an executable-frontmatter note refuses to come up rather than
      // starting compromised.
      await this.refuseUnvalidatedFetchedNotes();
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Run a read inside the mutex — the freshen step AND the read itself — so a read can
   * never observe another transaction's mid-mutation or mid-rollback tree state. The
   * returned headSha is captured in the same critical section the read ran in.
   *
   * The in-process enqueue mutex only serializes this Transactor's own operations; it's
   * blind to a second process (a rolling-restart overlap, the case the lockfile's
   * pid-embedded design already anticipates) mutating the shared checkout. So the read
   * also takes the same on-disk lock transact() holds, over its whole critical section
   * including the freshen step, because a cross-process write in flight can leave the
   * worktree mid-mutation or mid-rollback exactly when this read would parse it. The
   * trade-off is that a read can now fail with a LockError while a peer process is
   * writing, rather than silently observing a half-applied tree.
   */
  readTransaction<T>(read: () => Promise<T>): Promise<{ headSha: string; result: T }> {
    return this.enqueue(async () => {
      this.invalidateGitExecutionConfig();
      // acquireLock sits outside the try (same invariant as transact()): a failed acquire
      // must never reach the finally, because unlinking a foreign process's lockfile would
      // let a writer and this read interleave on the shared worktree.
      await this.acquireLock();
      try {
        if (Date.now() - this.lastFetchAt >= this.cfg.readFreshnessMs) {
          // A transient remote outage degrades reads to last-known state instead of
          // failing them (writes stay strict — their own fetch is unguarded). The
          // timestamp advances even on failure so an outage doesn't stall every read
          // behind a fetch timeout.
          await this.fetchRemote().catch(() => {});
          this.lastFetchAt = Date.now();
          if (!(await this.isDirty())) {
            // A diverged checkout can't fast-forward; reads then serve the last consistent
            // state rather than failing, and the next write will surface the problem.
            await this.gitChangingWorktree(['merge', '--ff-only', this.target()]).catch(() => {});
          }
        }
        // Unconditional, not gated on this call's own fetch above: transact()'s mandatory
        // fetch can have advanced HEAD between reads without ever visiting this method, and
        // a note it landed must still clear this check before the next read touches it.
        await this.refuseUnvalidatedFetchedNotes();
        const headSha = await this.git(['rev-parse', 'HEAD']);
        const result = await read();
        return { headSha, result };
      } finally {
        await this.releaseLock();
      }
    });
  }

  /** Run one mutation as a full transaction. Returns the pushed commit SHA and the mutation's result. */
  transact<T>(message: string, mutate: () => Promise<T>): Promise<{ sha: string; result: T }> {
    return this.enqueue(async () => {
      this.invalidateGitExecutionConfig();
      // acquireLock sits outside the try: a failed acquire must never reach the finally,
      // because unlinking a foreign process's lockfile would let two writers interleave.
      await this.acquireLock();
      let rollbackTo: string | undefined;
      // Populated once mutate() finishes; the catch block below unlinks these regardless
      // of why the transaction failed, because reset --hard + clean -fd can never touch a
      // gitignored path (git ls-files --ignored is the only thing that can see one).
      let newlyIgnoredPaths: string[] = [];
      try {
        if (await this.isDirty()) {
          throw new DirtyCheckoutError(
            'the checkout is dirty; refusing to write (restart the server to reconcile)',
          );
        }
        await this.fetchRemote();
        this.lastFetchAt = Date.now();
        await this.gitChangingWorktree(['merge', '--ff-only', this.target()]);
        // Same guard reconcileAtStartup and readTransaction run before serving anything
        // from HEAD: this fetch/merge can land a note carrying executable frontmatter, and
        // mutate() below is about to hand delegated tools a clone of this very HEAD, whose
        // readNote() parses frontmatter through gray-matter's default (unsafe) engines.
        await this.refuseUnvalidatedFetchedNotes();
        rollbackTo = await this.git(['rev-parse', 'HEAD']);
        const ignoredBefore = await this.ignoredFiles();
        const ignoredBeforeFingerprint = await this.ignoredFingerprint(ignoredBefore);

        let result: T;
        try {
          result = await mutate();
        } finally {
          // A delegated mutation can change an included config file in the worktree.
          // Rescan before status, validation, staging, or any rollback command runs.
          this.invalidateGitExecutionConfig();
        }

        const changed = await this.changedPaths();
        const ignoredBeforeSet = new Set(ignoredBefore);
        newlyIgnoredPaths = (await this.ignoredFiles()).filter(
          (path) => !ignoredBeforeSet.has(path),
        );

        // Validate each newly-ignored path first, because a .obsidian/.git write must keep
        // its specific by-name refusal — that guard throws before the generic ignored-write
        // refusal below collapses every remaining case into one message. Either throw lands
        // in the catch block below, which unlinks newlyIgnoredPaths itself — a newlyIgnored
        // path did not exist as an ignored file pre-transaction, so removing it there is
        // always safe, and a tracked-then-recreated one is restored by the catch's reset
        // --hard regardless.
        for (const relPath of newlyIgnoredPaths) {
          await this.cfg.validateChangedFile(relPath);
        }
        if (newlyIgnoredPaths.length > 0) {
          // git can neither stage nor commit a gitignored path, so this write cannot land —
          // we refuse the whole transaction even when tracked changes sit alongside, because
          // committing those would silently drop the ignored write and leave it on disk
          // (rollback's clean -fd never removes an ignored file).
          throw new HiddenIgnoredWriteError(
            `the mutation created gitignored path(s) [${newlyIgnoredPaths.join(', ')}] that git ` +
              'can neither stage nor commit; refusing the write',
          );
        }

        if ((await this.ignoredFingerprint(ignoredBefore)) !== ignoredBeforeFingerprint) {
          // git can neither stage nor commit an already-ignored path, so refuse the whole
          // mutation even when tracked changes accompany it; committing those would report
          // partial success while silently dropping the ignored half.
          throw new HiddenIgnoredWriteError(
            'the mutation touched an already-gitignored path, which git cannot stage or ' +
              'commit; refusing to report success for an untracked write',
          );
        }
        if (changed.length === 0) {
          return { sha: rollbackTo, result };
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

        return { sha: await this.pushWithRetries(), result };
      } catch (err) {
        if (rollbackTo !== undefined && !(err instanceof IndeterminatePushError)) {
          await this.gitChangingWorktree(['rebase', '--abort']).catch(() => {});
          await this.gitChangingWorktree(['reset', '--hard', rollbackTo]).catch(() => {});
          await this.gitChangingWorktree(['clean', '-fd']).catch(() => {});
        }
        // ls-files --ignored lists files, never directories, so unlink is the right
        // removal for every entry here.
        for (const relPath of newlyIgnoredPaths) {
          await unlink(join(this.cfg.vaultPath, relPath)).catch(() => {});
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
        await this.git(['push', '--', this.cfg.remote, `HEAD:${this.cfg.branch}`], {
          timeoutMs: NETWORK_GIT_TIMEOUT_MS,
        });
        return await this.git(['rev-parse', 'HEAD']);
      } catch (err) {
        // A failed push may still have landed: the remote can update the ref and
        // the ACK get lost afterwards, so check reachability before treating this
        // as a failure — otherwise we'd roll back and report "nothing was changed"
        // for a write that IS on the remote, and the caller's retry would duplicate it.
        try {
          await this.fetchRemote();
        } catch (fetchErr) {
          throw new IndeterminatePushError(
            'the push failed and the remote could not be re-read, so whether the commit ' +
              'landed is unknown; do not retry blindly — re-read the vault first: ' +
              `push error: ${(err as Error).message}; fetch error: ${(fetchErr as Error).message}`,
          );
        }
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
          await this.gitChangingWorktree(
            ['-c', 'commit.gpgsign=false', 'rebase', this.target()],
            {
              env: this.commitEnv(),
            },
          );
        } catch (rebaseErr) {
          await this.gitChangingWorktree(['rebase', '--abort']).catch(() => {});
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
    const count = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), 200)
      : 1;
    const args = ['log', '--format=%h %an %ad %s', '--date=short', '-n', String(count)];
    if (path !== undefined) {
      args.push('--', path);
    }
    return this.git(args);
  }
}
