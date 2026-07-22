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
});
