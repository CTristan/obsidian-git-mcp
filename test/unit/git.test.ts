import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('runGit timeout', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the default 30s ceiling when no timeoutMs is given', async () => {
    // `--version` never touches the network or the working tree, so the default
    // timeout is irrelevant to whether it succeeds — this just proves the
    // no-options path still works once GitOptions grew a second field.
    const out = await runGit(['--version'], dir);
    expect(out).toContain('git version');
  });

  it('honors a caller-supplied timeoutMs instead of the hardcoded 30s', async () => {
    // `hash-object --stdin` blocks reading from stdin forever unless killed — it
    // never completes on its own, so there is no race between "the command
    // finished" and "the timeout fired" to make this flaky. Before the fix,
    // GitOptions had no timeoutMs field and this would hang for the full 30s.
    const start = Date.now();
    const err: unknown = await runGit(['hash-object', '--stdin'], dir, {
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(GitError);
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe('runGit host hook neutralization', () => {
  let dir: string;
  let hooksDir: string;
  let markerPath: string;
  let globalConfig: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-repo-'));
    hooksDir = await mkdtemp(join(tmpdir(), 'ogm-git-hooks-'));
    markerPath = join(hooksDir, 'pre-commit-ran');
    // A hostile host hook: it would fire on every server-driven commit and record here
    // that it ran. It exits 0 so the commit still succeeds — the marker, not a failed
    // commit, is what proves whether host-configured hook code executed.
    const hook = join(hooksDir, 'pre-commit');
    await writeFile(hook, `#!/bin/sh\necho ran > "${markerPath}"\nexit 0\n`);
    await chmod(hook, 0o755);
    // Simulate the host's global git config leaking a core.hooksPath (plus the identity a
    // commit needs), the exact config layer a server-driven git command inherits.
    globalConfig = join(hooksDir, 'gitconfig');
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = ${hooksDir}\n`,
    );
    await runGit(['init', '.'], dir, {
      env: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('does not run a core.hooksPath hook inherited from host git config', async () => {
    // core.hooksPath from any config layer makes a server commit execute arbitrary host
    // code. runGit must neutralize it per-invocation, so this commit completes and leaves
    // no marker even though the (simulated) host global config points straight at the hook.
    await runGit(['commit', '--allow-empty', '-m', 'probe'], dir, {
      env: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    expect(existsSync(markerPath)).toBe(false);
  });
});
