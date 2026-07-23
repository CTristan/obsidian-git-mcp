import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCloneDiff,
  COPY_CHUNK_SIZE,
  manifestOf,
  type Manifest,
} from '../../src/staging.js';

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
    ).rejects.toThrow(/non-directory|outside the vault|path changed/);
    // Nothing was created at the external target.
    expect(existsSync(join(outside, 'new.md'))).toBe(false);
    expect(await readdir(outside)).toEqual([]);
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
    ).rejects.toThrow(/non-directory|outside the vault|path changed/);
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

    expect(new Set(manifest.keys())).toEqual(
      new Set(['a.md', 'sub/b.md', 'sub/c.md', 'dirlink', 'filelink']),
    );
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
