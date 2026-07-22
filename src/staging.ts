import { constants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

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
 * Clone the vault worktree into an ephemeral 0700 dir so a delegated write mutates a
 * throwaway copy instead of the live vault. Every top-level entry except `.git` is copied
 * — `.git` is the server's own transaction state, never something a delegated tool writes,
 * and excluding it keeps the clone small. verbatimSymlinks preserves each symlink as a
 * link (the containment check downstream depends on seeing links, not their resolved
 * targets), and FICLONE requests a copy-on-write reflink per file, silently falling back
 * to a byte copy on filesystems without reflink support (the CI path on ubuntu).
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
    if (entry === '.git') continue;
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
    for (const dirent of await readdir(cur, { withFileTypes: true })) {
      const abs = join(cur, dirent.name);
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      // isDirectory()/isSymbolicLink() come from readdir's own lstat, so a symlink to a
      // directory is a symlink here, not a directory — it's recorded, not descended into.
      if (dirent.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      const st = await lstat(abs, { bigint: true });
      manifest.set(rel, {
        size: st.size,
        mtimeNs: st.mtimeNs,
        ino: st.ino,
        isSymlink: dirent.isSymbolicLink(),
      });
    }
  };
  await walk(dir, '');
  return manifest;
}

/**
 * Write every byte of `bytes` at absolute offset 0 of an already-open, already-truncated
 * handle, looping until nothing remains. A single FileHandle.write can report a short
 * write on a regular file, which — because callers truncate first — would otherwise leave
 * a note holding only a prefix of its intended content. Passing an explicit position each
 * pass keeps the write independent of the handle's own offset.
 */
export async function writeAllAt(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) {
      throw new Error('write made no progress');
    }
    offset += bytesWritten;
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
 * Copy one changed/added clone file into the real vault through an fd-pinned write. We
 * open the target with O_NOFOLLOW (its final hop can't be a symlink under us), then
 * re-resolve and match the bound fd's inode against the resolved path before trusting it.
 * Soundness mirrors appendTool's: a swap BEFORE open is caught here — the resolved path
 * escapes the vault or no longer maps to the pinned inode; a swap AFTER open can't
 * redirect anything, because the fd is already bound to the validated inode, not to a name
 * the attacker can re-point. Same-uid live tampering of the ephemeral clone dir stays
 * theoretically possible, because nothing userland eliminates a same-uid attacker.
 */
async function writeIntoVault(
  vaultPath: string,
  realVaultPath: string,
  cloneDir: string,
  rel: string,
): Promise<void> {
  const bytes = await readFile(join(cloneDir, rel));
  const target = join(vaultPath, rel);
  await mkdirNoFollow(vaultPath, rel);
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    const resolved = await realpath(target);
    // Strict equality, not mere containment: a diff path never traverses a symlink in the
    // clone (the walk records links without descending them), so its live-vault counterpart
    // must resolve to exactly the canonical path — a resolution landing anywhere else, even
    // inside the vault, is a redirect, not our write.
    if (resolved !== join(realVaultPath, rel)) {
      throw new Error(`${rel}: path changed during the write`);
    }
    const [handleStat, pathStat] = await Promise.all([handle.stat(), stat(resolved)]);
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
      throw new Error(`${rel}: path changed during the write`);
    }
    // truncate first, because a shrinking write would otherwise leave stale trailing bytes.
    await handle.truncate(0);
    await writeAllAt(handle, bytes);
  } finally {
    await handle?.close();
  }
}

/**
 * Reconcile the real vault against a delegated write that ran in the clone: copy every
 * changed/added file back through fd-pinned writes, and remove every deleted one. A
 * changed/added entry that is a symlink is refused outright — MCPVault never creates or
 * rewrites symlinks, so one appearing in the diff is tampering, not a legitimate write
 * (an unchanged in-vault symlink the write merely resolved *through* never enters the
 * diff, so it stays untouched). This is the only path that mutates the real vault, and it
 * only ever does so through the fd-pinned writer above.
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
    const target = join(vaultPath, rel);
    // lstat then unlink: unlink never follows a final symlink, so a deleted entry that was
    // a symlink drops only the in-vault link, never whatever it pointed at. Tolerate a
    // path that already vanished (a concurrent removal) rather than failing the write.
    try {
      await lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    await unlink(target).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}
