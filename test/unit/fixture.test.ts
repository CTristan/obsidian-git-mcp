import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFixturePath } from '../fixture.js';

describe('resolveFixturePath', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogm-fixture-path-'));
    outside = await mkdtemp(join(tmpdir(), 'ogm-fixture-outside-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('resolves nested paths inside the throwaway checkout', async () => {
    await expect(resolveFixturePath(root, 'nested/note.md')).resolves.toBe(
      resolve(root, 'nested/note.md'),
    );
  });

  it('rejects relative and absolute escapes from the throwaway checkout', async () => {
    await expect(resolveFixturePath(root, '../outside.md')).rejects.toThrow(/escapes/);
    await expect(
      resolveFixturePath(root, resolve(root, '..', 'outside.md')),
    ).rejects.toThrow(/escapes/);
  });

  it('rejects an existing symlinked parent before a write can follow it', async () => {
    await mkdir(join(outside, 'nested'));
    await symlink(outside, join(root, 'linked'));

    await expect(resolveFixturePath(root, 'linked/nested/note.md')).rejects.toThrow(
      /symlink/,
    );
  });
});
