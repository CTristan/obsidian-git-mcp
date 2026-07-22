import { constants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One file or symlink recorded by manifestOf. mtime is nanosecond-precise (bigint) on
 * purpose: millisecond granularity could miss a same-size in-place rewrite that lands
 * within one millisecond of the original, and this fingerprint is the only signal that a
 * delegated write touched a file at all.
 */
export interface ManifestEntry {
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
  isSymlink: boolean;
}

/** Every file/symlink under a staged clone, keyed by clone-relative path. */
export type Manifest = Map<string, ManifestEntry>;

/**
 * Cap on how many of one directory's entries manifestOf lstats at once. A flat attachments
 * folder with years of pasted images is a real vault shape, and an uncapped Promise.all over
 * it would fire thousands of concurrent lstat calls — nested walk recursion stacking still
 * more on top — which starves libuv's threadpool and hits EMFILE instead of scaling. 64 keeps
 * the parallelism win while bounding the outstanding fd/threadpool load.
 */
const DIR_CONCURRENCY = 64;

/**
 * Clone the vault worktree into an ephemeral 0700 dir so a delegated write mutates a
 * throwaway copy instead of the live vault. Every top-level entry except `.git` and
 * `.obsidian` is copied — `.git` is the server's own transaction state, `.obsidian` is
 * Obsidian's own gitignored workspace/cache tree (can hold multi-MB of plugin data, per
 * transaction.ts's ignoredFiles doc), and forbiddenPathReason refuses any delegated write
 * under either anyway, so a stage that never receives it just skips paying for a copy (and
 * a later manifestOf walk) it would only have to throw away. verbatimSymlinks preserves
 * each symlink as a link (the containment check downstream depends on seeing links, not
 * their resolved targets), and FICLONE requests a copy-on-write reflink per file, silently
 * falling back to a byte copy on filesystems without reflink support (the CI path on
 * ubuntu).
 */
export async function cloneWorktree(vaultPath: string): Promise<string> {
  // mkdtemp has no mode option, so tighten to 0700 before copying anything in — the clone
  // holds real vault content and must not be world-readable while it's populated.
  const dir = await mkdtemp(join(tmpdir(), 'ogm-stage-'));
  await chmod(dir, 0o700);
  const opts = {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  } as const;
  for (const entry of await readdir(vaultPath)) {
    if (entry === '.git' || entry === '.obsidian') continue;
    await cp(join(vaultPath, entry), join(dir, entry), opts);
  }
  return dir;
}

/**
 * Fingerprint every file and symlink under `dir` (lstat, so a symlink records its own
 * stat, never its target's). Directories are traversed but not recorded, and a
 * symlink-to-directory is recorded as a symlink rather than followed — the walk never
 * leaves the tree it started in.
 */
export async function manifestOf(dir: string): Promise<Manifest> {
  const manifest: Manifest = new Map();
  const walk = async (cur: string, prefix: string): Promise<void> => {
    const dirents = await readdir(cur, { withFileTypes: true });
    // Every entry's lstat (or recursive walk) is independent of every other's, so batch them
    // through Promise.all instead of awaiting one at a time — otherwise scan latency scales
    // linearly with the vault's file count. Slice into DIR_CONCURRENCY-sized waves so a huge
    // flat directory can't fan out into thousands of simultaneous lstats.
    for (let i = 0; i < dirents.length; i += DIR_CONCURRENCY) {
      await Promise.all(
        dirents.slice(i, i + DIR_CONCURRENCY).map(async (dirent) => {
          const abs = join(cur, dirent.name);
          const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
          // isDirectory()/isSymbolicLink() come from readdir's own lstat, so a symlink to a
          // directory is a symlink here, not a directory — it's recorded, not descended into.
          if (dirent.isDirectory()) {
            await walk(abs, rel);
            return;
          }
          const st = await lstat(abs, { bigint: true });
          manifest.set(rel, {
            size: st.size,
            mtimeNs: st.mtimeNs,
            ino: st.ino,
            isSymlink: dirent.isSymbolicLink(),
          });
        }),
      );
    }
  };
  await walk(dir, '');
  return manifest;
}

/**
 * Write every byte of `bytes` at absolute file offset `filePosition` (default 0) of an
 * already-open handle, looping until nothing remains. A single FileHandle.write can report a
 * short write on a regular file, which — because callers truncate first — would otherwise
 * leave a note holding only a prefix of its intended content. Passing an explicit position
 * each pass keeps the write independent of the handle's own offset, which also lets a chunked
 * copy place successive buffers at their own file positions.
 */
export async function writeAllAt(
  handle: FileHandle,
  bytes: Buffer,
  filePosition = 0,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      filePosition + offset,
    );
    if (bytesWritten === 0) {
      throw new Error('write made no progress');
    }
    offset += bytesWritten;
  }
}

/**
 * Chunk size for the streaming clone→vault copy-back. Obsidian vaults hold large binary
 * attachments (images, PDFs, video); reading one in fixed 64 KiB slices keeps a multi-GB file
 * from ever landing in memory whole.
 */
export const COPY_CHUNK_SIZE = 64 * 1024;

/**
 * Copy `source` into `dest` in COPY_CHUNK_SIZE slices, reusing one buffer and driving both
 * sides with explicit positions so nothing depends on either handle's own offset. `dest` must
 * already be truncated and pinned — this only moves bytes, never opens or resolves a path — so
 * it inherits writeIntoVault's pinning guarantee unchanged.
 */
async function streamCopy(source: FileHandle, dest: FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_SIZE);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    await writeAllAt(dest, buffer.subarray(0, bytesRead), position);
    position += bytesRead;
  }
}

function isUnchanged(before: ManifestEntry | undefined, after: ManifestEntry): boolean {
  return (
    before !== undefined &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ino === after.ino &&
    before.isSymlink === after.isSymlink
  );
}

/**
 * Create rel's parent directories under vaultPath without ever following a symlink. Plain
 * mkdir({recursive}) would traverse a pre-existing symlinked intermediate directory and
 * create dirs at its external target — happening BEFORE writeIntoVault's O_NOFOLLOW/realpath
 * guards, so those never see it. We instead lstat each segment: an existing directory is
 * descended, a missing one is created a single level at a time, and a symlink (or any
 * non-directory) is refused. mkdir without `recursive` throws EEXIST if a segment races into
 * existence between the lstat and the mkdir, which rolls the transaction back rather than
 * following whatever now sits there.
 */
async function mkdirNoFollow(vaultPath: string, rel: string): Promise<void> {
  // Reject a literal ".." segment at this layer too. It's unreachable today — manifestOf
  // builds rel from real readdir entries, and no directory entry is ever named ".." — but
  // the contract is that traversal is refused independently here, not only upstream, so
  // the join()-based paths below can never be trusted to a caller's discipline alone.
  if (rel.split('/').includes('..')) {
    throw new Error(`${rel}: refusing to write through a path-traversal segment`);
  }
  let cur = vaultPath;
  for (const segment of dirname(rel).split('/')) {
    if (segment === '' || segment === '.') continue;
    cur = join(cur, segment);
    try {
      const st = await lstat(cur);
      if (!st.isDirectory()) {
        throw new Error(`${rel}: refusing to write through a non-directory at ${segment}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(cur, { mode: 0o755 });
    }
  }
}

/**
 * Open `openTarget` for writing and hand back a handle pinned to `expectedReal`, or throw
 * (via `makeMismatchError`, closing the handle first) if the two go out of sync between
 * resolution and open. `flags` must carry O_NOFOLLOW, so a symlink dropped in at the final
 * path segment fails the open outright rather than getting silently followed. Two checks
 * cover what O_NOFOLLOW alone can't:
 *
 * - `reResolveTarget` (the same path as `openTarget` for a caller that resolved its target
 *   right before opening it; the caller's original, possibly symlink-laden argument for one
 *   that resolved it earlier, before an await boundary) must still realpath() to exactly
 *   `expectedReal` — catching a symlink swapped in anywhere along that path's resolution
 *   chain, not just its final segment.
 * - The open handle's dev/ino must match a fresh stat of `expectedReal` — catching a
 *   same-name regular-file replacement, which a realpath match alone can't, since unlink
 *   followed by recreating a plain file at the same name resolves identically.
 *
 * A swap before this runs is caught by one of the two checks above; a swap after is moot,
 * because the returned fd is already bound to the validated inode, not to a name an
 * attacker can re-point. Callers own containment — this only pins whatever `expectedReal`
 * turned out to be, and must already have confirmed it sits inside the vault. On success,
 * closing the returned handle is the caller's responsibility.
 */
export async function openPinnedHandle(
  openTarget: string,
  reResolveTarget: string,
  expectedReal: string,
  flags: number,
  makeMismatchError: (message: string) => Error,
): Promise<FileHandle> {
  const handle = await open(openTarget, flags, 0o644);
  try {
    const resolved = await realpath(reResolveTarget);
    if (resolved !== expectedReal) {
      throw makeMismatchError('path changed during the write');
    }
    const [handleStat, pathStat] = await Promise.all([handle.stat(), stat(expectedReal)]);
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
      throw makeMismatchError('path changed during the write');
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/**
 * Copy one changed/added clone file into the real vault through openPinnedHandle. Strict
 * equality against `join(realVaultPath, rel)`, not mere containment: a diff path never
 * traverses a symlink in the clone (the walk records links without descending them), so
 * its live-vault counterpart must resolve to exactly the canonical path — a resolution
 * landing anywhere else, even inside the vault, is a redirect, not our write. Same-uid live
 * tampering of the ephemeral clone dir stays theoretically possible, because nothing
 * userland eliminates a same-uid attacker.
 */
async function writeIntoVault(
  vaultPath: string,
  realVaultPath: string,
  cloneDir: string,
  rel: string,
): Promise<void> {
  const target = join(vaultPath, rel);
  await mkdirNoFollow(vaultPath, rel);
  const handle = await openPinnedHandle(
    target,
    target,
    join(realVaultPath, rel),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    (message) => new Error(`${rel}: ${message}`),
  );
  try {
    // The vault handle is pinned before any bytes move; the clone read only opens after, and
    // applyCloneDiff already refused any symlink in the diff, so rel is a plain file here.
    const source = await open(join(cloneDir, rel), constants.O_RDONLY);
    try {
      // truncate first, because a shrinking write would otherwise leave stale trailing bytes.
      await handle.truncate(0);
      await streamCopy(source, handle);
    } finally {
      await source.close();
    }
  } finally {
    await handle.close();
  }
}

/**
 * Delete rel's target from vaultPath without ever following a symlink standing in for a
 * parent directory. Walks each parent segment exactly like mkdirNoFollow — refusing a
 * symlink or non-directory anywhere in the chain — then confirms the resolved *parent*
 * still lands at the canonical vault location before unlinking, closing the same
 * swapped-parent window openPinnedHandle closes for writes. The check deliberately stops at
 * the parent: realpath(target) would follow rel's own symlink to its target, which is never
 * the same as rel's own canonical path, so resolving the entry itself would make deleting
 * any legitimate pre-existing vault symlink fail every time. unlink() itself never follows
 * a symlink at the final segment, so a deleted entry that was a symlink drops only the
 * in-vault link, never whatever it pointed at.
 */
async function unlinkNoFollow(
  vaultPath: string,
  realVaultPath: string,
  rel: string,
): Promise<void> {
  // Reject a literal ".." segment at this layer too, mirroring mkdirNoFollow's independent
  // guarantee — see the comment there for why upstream discipline alone isn't trusted.
  if (rel.split('/').includes('..')) {
    throw new Error(`${rel}: refusing to delete through a path-traversal segment`);
  }
  let cur = vaultPath;
  for (const segment of dirname(rel).split('/')) {
    if (segment === '' || segment === '.') continue;
    cur = join(cur, segment);
    const st = await lstat(cur);
    if (!st.isDirectory()) {
      throw new Error(`${rel}: refusing to delete through a non-directory at ${segment}`);
    }
  }
  const target = join(vaultPath, rel);
  const parentReal = await realpath(dirname(target));
  if (parentReal !== dirname(join(realVaultPath, rel))) {
    throw new Error(`${rel}: refusing to delete — path resolved outside the vault`);
  }
  await unlink(target);
}

/**
 * Reconcile the real vault against a delegated write that ran in the clone: copy every
 * changed/added file back through fd-pinned writes, and remove every deleted one. A
 * changed/added entry that is a symlink is refused outright — MCPVault never creates or
 * rewrites symlinks, so one appearing in the diff is tampering, not a legitimate write
 * (an unchanged in-vault symlink the write merely resolved *through* never enters the
 * diff, so it stays untouched). This and appendTool (server.ts) are the only two paths
 * that mutate the real vault, and both do so exclusively through openPinnedHandle above.
 */
export async function applyCloneDiff(
  vaultPath: string,
  realVaultPath: string,
  cloneDir: string,
  before: Manifest,
  after: Manifest,
): Promise<void> {
  for (const [rel, entry] of after) {
    if (isUnchanged(before.get(rel), entry)) continue;
    if (entry.isSymlink) {
      throw new Error(`${rel}: refusing to copy a symlink created during the write`);
    }
    await writeIntoVault(vaultPath, realVaultPath, cloneDir, rel);
  }
  for (const rel of before.keys()) {
    if (after.has(rel)) continue;
    // Tolerate a path that already vanished anywhere along the walk (a concurrent
    // removal) rather than failing the write.
    try {
      await unlinkNoFollow(vaultPath, realVaultPath, rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}
