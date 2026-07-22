import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, runGit } from '../../src/git.js';

describe('GitError credential redaction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('redacts embedded credentials from message, args, and stderr', () => {
    // GitError is part of the public surface (re-exported from src/index.ts) and its
    // message can reach MCP tool responses, so a remote URL's user:token must never
    // survive in any of the three places a consumer might log.
    const url = 'https://user:sekret@example.invalid/repo.git';
    const err = new GitError(
      `git fetch ${url} failed: fatal: unable to access '${url}'`,
      ['fetch', url],
      `fatal: unable to access '${url}': could not resolve host`,
    );
    for (const surface of [err.message, err.stderr, err.args.join(' ')]) {
      expect(surface).not.toContain('sekret');
      expect(surface).toContain('://***@');
    }
  });

  it('runGit failures never leak a credentialed URL argument', async () => {
    // `git fetch` outside a repository dies on "not a git repository" before any
    // network access, so the credentialed URL only surfaces via the echoed args.
    const err: unknown = await runGit(
      ['fetch', 'https://user:sekret@example.invalid/repo.git'],
      dir,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).not.toContain('sekret');
  });
});
