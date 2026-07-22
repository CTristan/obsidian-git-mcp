import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCloneDiff, type Manifest } from '../../src/staging.js';

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
});
