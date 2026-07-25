import { randomBytes } from 'node:crypto';
import { constants, existsSync, type Stats } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCloneDiff,
  cloneWorktree,
  COPY_CHUNK_SIZE,
  DIR_CONCURRENCY,
  manifestOf,
  openPinnedHandle,
  writeAllAt,
  type Manifest,
} from '../../src/staging.js';

vi.mock('node:fs/promises', { spy: true });

describe('applyCloneDiff symlink safety', () => {
  let root: string;
  let vaultPath: string;
  let cloneDir: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogm-staging-'));
    vaultPath = join(root, 'vault');
    cloneDir = join(root, 'clone');
    outside = join(root, 'outside');
    await mkdir(vaultPath);
    await mkdir(cloneDir);
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to create directories through a symlinked intermediate path', async () => {
    // A same-uid racer swaps a real vault subdirectory for a symlink pointing outside the
    // vault after the clone was taken. Copying an added file whose path runs through that
    // segment must refuse rather than let mkdir follow the link and create dirs/files at
    // the external target.
    await symlink(outside, join(vaultPath, 'notes'));
    await mkdir(join(cloneDir, 'notes'));
    await writeFile(join(cloneDir, 'notes', 'new.md'), '# New\n');

    const before: Manifest = new Map();
    const after: Manifest = new Map([
      ['notes/new.md', { size: 6n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
    ]);

    await expect(
      applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after),
    ).rejects.toThrow(/refusing to write through a non-directory/);
    // Nothing was created at the external target.
    expect(existsSync(join(outside, 'new.md'))).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a clone source swapped to a symlink after the manifest scan', async () => {
    const target = join(vaultPath, 'note.md');
    const source = join(cloneDir, 'note.md');
    const outsideFile = join(outside, 'secret.md');
    await writeFile(target, 'original\n');
    await writeFile(source, 'staged\n');
    await writeFile(outsideFile, 'outside secret\n');
    const after = await manifestOf(cloneDir);
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockImplementation((async (path: string, flags: number, mode?: number) => {
      if (path === source) {
        await unlink(source);
        await symlink(outsideFile, source);
      }
      return actual.open(path, flags, mode);
    }) as typeof fsPromises.open);

    try {
      await expect(
        applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, new Map(), after),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      expect(await readFile(target, 'utf8')).toBe('original\n');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('refuses to delete through a symlinked intermediate path', async () => {
    // A same-uid racer swaps a real vault subdirectory for a symlink pointing outside the
    // vault after the clone was taken, then plants a same-named file outside. Removing a
    // clone-deleted entry that runs through that segment must refuse rather than let
    // unlink resolve through the link and remove the external file.
    await writeFile(join(outside, 'old.md'), '# Old\n');
    await symlink(outside, join(vaultPath, 'notes'));

    const before: Manifest = new Map([
      ['notes/old.md', { size: 6n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
    ]);
    const after: Manifest = new Map();

    await expect(
      applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after),
    ).rejects.toThrow(/refusing to delete through a non-directory/);
    // The external file survived — the delete never followed the swapped symlink.
    expect(existsSync(join(outside, 'old.md'))).toBe(true);
  });

  it('refuses to copy back a symlink that appeared in the diff', async () => {
    // MCPVault never creates symlinks, so one showing up as added/changed is tampering.
    // applyCloneDiff must refuse rather than reproduce it in the live vault.
    await symlink(outside, join(cloneDir, 'Link.md'));

    const before: Manifest = new Map();
    const after: Manifest = new Map([
      ['Link.md', { size: 0n, mtimeNs: 1n, ino: 1n, isSymlink: true }],
    ]);

    await expect(
      applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after),
    ).rejects.toThrow(/symlink/);
    expect(existsSync(join(vaultPath, 'Link.md'))).toBe(false);
  });

  it('refuses to copy an added entry whose manifest path runs under .git', async () => {
    // cloneWorktree never copies .git into the clone, so this path can only reach the diff
    // if a delegated write escaped its argument-validated target and created one anyway.
    // The copy-back boundary must refuse it independently of that upstream invariant,
    // exactly like the append path already does via forbiddenPathReason.
    await mkdir(join(cloneDir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(cloneDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nevil\n');

    const before: Manifest = new Map();
    const after: Manifest = new Map([
      ['.git/hooks/pre-commit', { size: 15n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
    ]);

    await expect(
      applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after),
    ).rejects.toThrow(/not allowed/);
    expect(existsSync(join(vaultPath, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('refuses to delete a manifest entry whose path runs under .obsidian', async () => {
    // A restricted-segment path has no business appearing in `before` either, but the
    // delete side gets the same independent refusal as the write side rather than trusting
    // that only legitimate entries ever end up there.
    const before: Manifest = new Map([
      ['.obsidian/app.json', { size: 2n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
    ]);
    const after: Manifest = new Map();

    await expect(
      applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after),
    ).rejects.toThrow(/not allowed/);
  });

  it('deletes a legitimate pre-existing symlink entry without touching its target', async () => {
    // manifestOf records any pre-existing vault symlink with isSymlink: true. Removing one
    // in the clone must actually delete the in-vault link, not refuse it as if it were an
    // escape attempt — and unlink must drop only the link, never follow it to disturb the
    // target directory it points at.
    await writeFile(join(outside, 'keep.md'), '# Keep\n');
    await symlink(outside, join(vaultPath, 'Link.md'));

    const before: Manifest = new Map([
      ['Link.md', { size: 0n, mtimeNs: 1n, ino: 1n, isSymlink: true }],
    ]);
    const after: Manifest = new Map();

    await applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after);

    expect(existsSync(join(vaultPath, 'Link.md'))).toBe(false);
    // The link target directory and its contents survived — the delete never followed the link.
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(outside, 'keep.md'))).toBe(true);
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('# Keep\n');
  });

  it('removes now-empty parent directories after cascading deletes', async () => {
    // Deleting every file under a nested subtree should carry the now-empty intermediate dirs
    // out of the live vault too, but stop at the first non-empty ancestor and never touch the
    // vault root.
    await mkdir(join(vaultPath, 'parent', 'deep', 'sub'), { recursive: true });
    await writeFile(join(vaultPath, 'parent', 'deep', 'sub', 'a.md'), '# A\n');
    await writeFile(join(vaultPath, 'parent', 'deep', 'sub', 'b.md'), '# B\n');
    await writeFile(join(vaultPath, 'parent', 'keep.md'), '# Keep\n');

    const keep = { size: 7n, mtimeNs: 1n, ino: 3n, isSymlink: false };
    const before: Manifest = new Map([
      ['parent/deep/sub/a.md', { size: 4n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
      ['parent/deep/sub/b.md', { size: 4n, mtimeNs: 1n, ino: 2n, isSymlink: false }],
      ['parent/keep.md', keep],
    ]);
    const after: Manifest = new Map([['parent/keep.md', keep]]);

    await applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after);

    // The emptied subtree is gone up to — but not including — the first non-empty ancestor.
    expect(existsSync(join(vaultPath, 'parent', 'deep', 'sub'))).toBe(false);
    expect(existsSync(join(vaultPath, 'parent', 'deep'))).toBe(false);
    // `parent` still holds keep.md, and the vault root is never an rmdir candidate.
    expect(existsSync(join(vaultPath, 'parent', 'keep.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'parent'))).toBe(true);
    expect(existsSync(vaultPath)).toBe(true);
  });

  it('never follows or removes a symlinked directory while cleaning up', async () => {
    // A pre-existing symlink-to-directory sits beside a subtree whose last file is deleted. The
    // emptied leaf dir goes away, but the symlink keeps its parent non-empty, so cleanup must
    // leave that parent, the link itself, and the link's target directory all untouched — rmdir
    // must never follow the link to delete what it points at.
    await writeFile(join(outside, 'target.md'), '# Target\n');
    await mkdir(join(vaultPath, 'area', 'deep'), { recursive: true });
    await writeFile(join(vaultPath, 'area', 'deep', 'a.md'), '# A\n');
    await symlink(outside, join(vaultPath, 'area', 'linkdir'));

    const link = { size: 0n, mtimeNs: 1n, ino: 9n, isSymlink: true };
    const before: Manifest = new Map([
      ['area/deep/a.md', { size: 4n, mtimeNs: 1n, ino: 1n, isSymlink: false }],
      ['area/linkdir', link],
    ]);
    const after: Manifest = new Map([['area/linkdir', link]]);

    await applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after);

    // The emptied leaf dir went away...
    expect(existsSync(join(vaultPath, 'area', 'deep'))).toBe(false);
    // ...but `area` stayed (the symlink keeps it non-empty), and the symlink itself and its
    // target were never followed or removed.
    expect(existsSync(join(vaultPath, 'area'))).toBe(true);
    expect((await lstat(join(vaultPath, 'area', 'linkdir'))).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'target.md'))).toBe(true);
    expect(await readdir(outside)).toEqual(['target.md']);
  });
});

describe('cloneWorktree failure cleanup', () => {
  let tmpRoot: string;
  let vaultPath: string;
  let savedTmpdir: string | undefined;

  beforeEach(async () => {
    // Redirect os.tmpdir() at the source (cloneWorktree hard-codes tmpdir()) so the only
    // ogm-stage-* dir under it is the one cloneWorktree creates — the assertion can then read
    // the whole dir and prove no stage leaked.
    tmpRoot = await mkdtemp(join(tmpdir(), 'ogm-clone-cleanup-'));
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    vaultPath = join(tmpRoot, 'vault');
    await mkdir(vaultPath);
  });

  afterEach(async () => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // Skipped as root, where a 0000 file stays readable and cp would never fail.
  it.skipIf(process.getuid?.() === 0)(
    'removes its mkdtemp dir when copying an entry fails',
    async () => {
      // A readable note copies fine; an unreadable one makes cp() throw partway through the
      // top-level copy loop. cloneWorktree already created its 0700 mkdtemp dir by then, and
      // the sole caller only binds `stage` (and its finally-rm) on a successful return — so a
      // throw here must clean up after itself or orphan a temp dir holding partial vault content.
      await writeFile(join(vaultPath, 'readable.md'), '# ok\n');
      const secret = join(vaultPath, 'secret.md');
      await writeFile(secret, '# secret\n');
      await chmod(secret, 0o000);

      await expect(cloneWorktree(vaultPath)).rejects.toThrow();

      const leftovers = (await readdir(tmpRoot)).filter((n) => n.startsWith('ogm-stage-'));
      expect(leftovers).toEqual([]);
    },
  );

  it('removes its mkdtemp dir when the 0700 chmod fails', async () => {
    // The chmod that tightens the fresh mkdtemp dir has to sit inside the cleanup try: if it
    // throws, the dir it just created is orphaned, because the sole caller only binds `stage`
    // (and its finally-rm) on a successful return. Force the chmod to fail and the dir must
    // still be gone.
    await writeFile(join(vaultPath, 'readable.md'), '# ok\n');
    const chmodSpy = vi.mocked(chmod);
    chmodSpy.mockImplementationOnce(() => Promise.reject(new Error('chmod boom')));
    try {
      await expect(cloneWorktree(vaultPath)).rejects.toThrow(/chmod boom/);

      const leftovers = (await readdir(tmpRoot)).filter((n) => n.startsWith('ogm-stage-'));
      expect(leftovers).toEqual([]);
    } finally {
      chmodSpy.mockRestore();
    }
  });
});

describe('manifestOf nested tree', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogm-manifest-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fingerprints files and symlinks across a nested tree without descending links', async () => {
    // Regular files at the top level and one directory deep, plus a symlink to a directory and
    // a symlink to a file. The walk must record every file and every link, skip directories
    // themselves, and record a symlinked directory as a link rather than descending into it.
    await writeFile(join(root, 'a.md'), 'top\n');
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'b.md'), 'nested-b\n');
    await writeFile(join(root, 'sub', 'c.md'), 'nested-c\n');
    await symlink(join(root, 'sub'), join(root, 'dirlink'));
    await symlink(join(root, 'a.md'), join(root, 'filelink'));

    const manifest = await manifestOf(root);

    expect([...manifest.keys()]).toEqual([
      'a.md',
      'dirlink',
      'filelink',
      'sub/b.md',
      'sub/c.md',
    ]);
    // Directories are traversed but never recorded, and a symlinked directory is not descended.
    expect(manifest.has('sub')).toBe(false);
    expect(manifest.has('dirlink/b.md')).toBe(false);

    expect(manifest.get('a.md')?.isSymlink).toBe(false);
    expect(manifest.get('sub/b.md')?.isSymlink).toBe(false);
    expect(manifest.get('dirlink')?.isSymlink).toBe(true);
    expect(manifest.get('filelink')?.isSymlink).toBe(true);
    expect(manifest.get('a.md')?.size).toBe(4n);
  });
});

describe('manifestOf global lstat bound', () => {
  let root: string;
  let actual: typeof import('node:fs/promises');

  beforeEach(async () => {
    actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    root = await mkdtemp(join(tmpdir(), 'ogm-bound-'));
    // 8 directories x 20 files = 160 entries that become ready to lstat together as soon as
    // their parent directories are discovered — far past the 64 cap, so a per-directory fan-out
    // runs ~160 lstats at once (8 sibling subtrees x 20 each) while a global cap holds at 64.
    for (let d = 0; d < 8; d++) {
      const sub = join(root, `d${d}`);
      await mkdir(sub);
      for (let f = 0; f < 20; f++) {
        await writeFile(join(sub, `f${f}.md`), 'x\n');
      }
    }
  });

  afterEach(async () => {
    vi.mocked(lstat).mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it('never runs more than DIR_CONCURRENCY lstats at once across the whole nested tree', async () => {
    // Wrap the real lstat to count concurrent calls and force overlap with a small delay. The
    // old per-directory cap re-applied 64 fresh at each level, so sibling subtrees walking in
    // parallel multiplied it; the fix threads one shared limiter through the recursion so the
    // ceiling is global regardless of tree shape.
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(lstat).mockImplementation((async (path: string, options: unknown) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await actual.lstat(path, options as { bigint: true });
      } finally {
        inFlight--;
      }
    }) as typeof lstat);

    const manifest = await manifestOf(root);

    // The cap bounds concurrency, it never drops work: every file is still fingerprinted.
    expect(manifest.size).toBe(160);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(DIR_CONCURRENCY);
  });
});

describe('applyCloneDiff copy-back streaming', () => {
  let root: string;
  let vaultPath: string;
  let cloneDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogm-stream-'));
    vaultPath = join(root, 'vault');
    cloneDir = join(root, 'clone');
    await mkdir(vaultPath);
    await mkdir(cloneDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a multi-chunk attachment byte-identically', async () => {
    // Larger than one COPY_CHUNK_SIZE slice with a non-aligned remainder, so the chunked read/
    // write loop spans several full chunks plus a partial tail. Random bytes make any dropped,
    // duplicated, or misplaced chunk corrupt the round-trip rather than pass by coincidence.
    const payload = randomBytes(COPY_CHUNK_SIZE * 2 + 7);
    await mkdir(join(cloneDir, 'attachments'));
    await writeFile(join(cloneDir, 'attachments', 'big.bin'), payload);

    const before: Manifest = new Map();
    const after: Manifest = new Map([
      [
        'attachments/big.bin',
        { size: BigInt(payload.length), mtimeNs: 1n, ino: 1n, isSymlink: false },
      ],
    ]);

    await applyCloneDiff(vaultPath, await realpath(vaultPath), cloneDir, before, after);

    const written = await readFile(join(vaultPath, 'attachments', 'big.bin'));
    expect(written.length).toBe(payload.length);
    expect(Buffer.compare(written, payload)).toBe(0);
  });
});

describe('writeAllAt short-write resilience', () => {
  it('keeps writing until the whole buffer lands when a write reports a short count', async () => {
    // A single FileHandle.write can report a short write on a regular file, so writeAllAt must
    // loop on the reported byte count rather than assume one call drains the buffer. A fake
    // handle forces the first write to place a single byte, then reassembly of what landed at
    // each offset proves the loop finished the buffer — a truncated fragment fails the compare.
    const payload = Buffer.from('the whole payload has to land byte for byte at each offset\n');
    const landed = Buffer.alloc(payload.length);
    let calls = 0;
    const fakeHandle = {
      write: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const toWrite = calls === 0 ? 1 : length;
        calls++;
        buffer.copy(landed, position, offset, offset + toWrite);
        return { bytesWritten: toWrite, buffer };
      },
    } as unknown as FileHandle;

    await writeAllAt(fakeHandle, payload);

    expect(Buffer.compare(landed, payload)).toBe(0);
    // The forced short first write means writeAllAt had to issue at least one more call.
    expect(calls).toBeGreaterThan(1);
  });
});

describe('openPinnedHandle path pinning', () => {
  let root: string;
  const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogm-pin-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns a usable handle pinned to a regular file on the happy path', async () => {
    const target = join(root, 'note.md');
    await writeFile(target, 'seed\n');
    const expectedReal = await realpath(target);

    const handle = await openPinnedHandle(
      target,
      target,
      expectedReal,
      writeFlags,
      (message) => new Error(message),
    );
    try {
      await handle.truncate(0);
      await writeAllAt(handle, Buffer.from('written through the pinned handle\n'));
    } finally {
      await handle.close();
    }

    expect(await readFile(target, 'utf8')).toBe('written through the pinned handle\n');
  });

  it('refuses callers that omit O_NOFOLLOW from the open flags', async () => {
    const target = join(root, 'note.md');
    await writeFile(target, 'seed\n');
    const expectedReal = await realpath(target);

    await expect(
      openPinnedHandle(
        target,
        target,
        expectedReal,
        constants.O_WRONLY,
        (message) => new Error(message),
      ),
    ).rejects.toThrow(/requires O_NOFOLLOW/);
  });

  it('refuses to open when the final path segment is a symlink', async () => {
    const real = join(root, 'real.md');
    const link = join(root, 'link.md');
    await writeFile(real, 'seed\n');
    await symlink(real, link);

    await expect(
      openPinnedHandle(link, link, await realpath(link), writeFlags, (message) => new Error(message)),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(real, 'utf8')).toBe('seed\n');
  });

  it('refuses when the resolved path no longer matches the expected canonical path', async () => {
    // The realpath re-resolution guard: what we opened must still canonicalize to exactly the
    // path the caller pinned. Point expectedReal at a different real file so resolution
    // disagrees, standing in for a symlink swapped into the chain between resolve and open.
    const target = join(root, 'note.md');
    const decoy = join(root, 'decoy.md');
    await writeFile(target, 'seed\n');
    await writeFile(decoy, 'decoy\n');
    const wrongReal = await realpath(decoy);

    await expect(
      openPinnedHandle(target, target, wrongReal, writeFlags, (message) => new Error(message)),
    ).rejects.toThrow(/path changed during the write/);
  });

  it('refuses when the open handle and the pinned path resolve to different inodes', async () => {
    // The dev/ino guard catches what a realpath match can't: a same-name regular file unlinked
    // and recreated resolves identically, so only comparing the open fd's inode against a fresh
    // stat of the pinned path spots the swap. Force stat() to report a foreign inode while
    // realpath still agrees, and the pin must refuse.
    const target = join(root, 'note.md');
    await writeFile(target, 'seed\n');
    const expectedReal = await realpath(target);

    const statSpy = vi.mocked(fsPromises.stat);
    statSpy.mockImplementationOnce(
      () => Promise.resolve({ dev: -1, ino: -1 } as unknown as Stats),
    );
    try {
      await expect(
        openPinnedHandle(target, target, expectedReal, writeFlags, (message) => new Error(message)),
      ).rejects.toThrow(/path changed during the write/);
    } finally {
      statSpy.mockRestore();
    }
  });
});
