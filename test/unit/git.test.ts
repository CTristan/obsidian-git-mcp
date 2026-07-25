import { existsSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitExecutionCache,
  GitError,
  invalidateGitExecutionCache,
  runGit,
} from '../../src/git.js';

// Pin both config layers on every git call so host insteadOf, a credential helper, a proxy, or a
// leaked core.hooksPath can't change a command's behavior and make an assertion
// environment-dependent. Isolation callers take the default empty global config; the
// hook-neutralization tests pass their simulated-host config to prove runGit neutralizes it anyway.
let emptyConfigDir: string;
let emptyConfig: string;

beforeAll(async () => {
  emptyConfigDir = await mkdtemp(join(tmpdir(), 'ogm-git-config-'));
  emptyConfig = join(emptyConfigDir, 'gitconfig');
  await writeFile(emptyConfig, '');
});

afterAll(async () => {
  await rm(emptyConfigDir, { recursive: true, force: true });
});

function isolatedGitEnv(globalConfig = emptyConfig): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: emptyConfig };
}

function gitConfigPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function shellCommandPath(path: string): string {
  return `'${gitConfigPath(path).replaceAll("'", "'\\''")}'`;
}

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
      { env: isolatedGitEnv() },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).not.toContain('sekret');
  });
});

describe('GitError exit status', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-'));
    await runGit(['init', '.'], dir, { env: isolatedGitEnv() });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves the child process exit code for callers that interpret Git status', async () => {
    const err: unknown = await runGit(['check-ignore', '--', 'not-ignored.md'], dir, {
      env: isolatedGitEnv(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).toBe(1);
  });
});

describe('runGit timeout', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-'));
  });

  afterEach(async () => {
    // Windows can retain the killed Git process's working-directory handle briefly after
    // the timeout rejects, so give recursive cleanup a bounded retry window.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('uses the default 30s ceiling when no timeoutMs is given', async () => {
    // `--version` never touches the network or the working tree, so the default
    // timeout is irrelevant to whether it succeeds — this just proves the
    // no-options path still works once GitOptions grew a second field.
    const out = await runGit(['--version'], dir, { env: isolatedGitEnv() });
    expect(out).toContain('git version');
  });

  it('honors a caller-supplied timeoutMs instead of the hardcoded 30s', async () => {
    // `hash-object --stdin` blocks reading from stdin forever unless killed — it
    // never completes on its own, so there is no race between "the command
    // finished" and "the timeout fired" to make this flaky. Before the fix,
    // GitOptions had no timeoutMs field and this would hang for the full 30s.
    const start = Date.now();
    const err: unknown = await runGit(['hash-object', '--stdin'], dir, {
      env: isolatedGitEnv(),
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(GitError);
    expect(elapsed).toBeLessThan(3_000);
    expect((err as GitError).message).toMatch(/timed out/i);
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
    await writeFile(hook, `#!/bin/sh\necho ran > "${gitConfigPath(markerPath)}"\nexit 0\n`);
    await chmod(hook, 0o755);
    // Simulate the host's global git config leaking a core.hooksPath (plus the identity a
    // commit needs), the exact config layer a server-driven git command inherits.
    globalConfig = join(hooksDir, 'gitconfig');
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = ${gitConfigPath(hooksDir)}\n`,
    );
    await runGit(['init', '.'], dir, { env: isolatedGitEnv(globalConfig) });
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
      env: isolatedGitEnv(globalConfig),
    });
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('runGit host execution-vector neutralization', () => {
  let dir: string;
  let probeDir: string;
  let markerPath: string;
  let probePath: string;
  let globalConfig: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ogm-git-hardened-repo-'));
    probeDir = await mkdtemp(join(tmpdir(), 'ogm-git-hardened-probe-'));
    markerPath = join(probeDir, 'ran');
    probePath = join(probeDir, 'probe');
    globalConfig = join(probeDir, 'gitconfig');
    await writeFile(
      probePath,
      `#!/bin/sh\necho ran > "${gitConfigPath(markerPath)}"\ncat\n`,
    );
    await chmod(probePath, 0o755);
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[commit]\n\tgpgsign = false\n`,
    );
    await runGit(['init', '.'], dir, { env: isolatedGitEnv(globalConfig) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  });

  it('does not run a diff.external command inherited from host git config', async () => {
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[commit]\n\tgpgsign = false\n[diff]\n\texternal = ${shellCommandPath(probePath)}\n`,
    );
    await writeFile(join(dir, 'note.md'), 'before\n');
    await runGit(['add', 'note.md'], dir, { env: isolatedGitEnv(globalConfig) });
    await runGit(['commit', '-m', 'seed'], dir, { env: isolatedGitEnv(globalConfig) });
    await writeFile(join(dir, 'note.md'), 'after\n');

    const diff = await runGit(['diff'], dir, { env: isolatedGitEnv(globalConfig) });

    expect(diff).toContain('note.md');
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each(['sshCommand', 'gitProxy'])(
    'refuses execution-capable core.%s config instead of running it',
    async (key) => {
      await writeFile(
        globalConfig,
        `[user]\n\tname = Probe\n\temail = probe@test.local\n[core]\n\t${key} = ${shellCommandPath(probePath)}\n`,
      );

      const err: unknown = await runGit(['status', '--porcelain'], dir, {
        env: isolatedGitEnv(globalConfig),
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(GitError);
      expect((err as Error).message.toLowerCase()).toContain(`core.${key.toLowerCase()}`);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it('preserves option-like pathspecs after the -- separator', async () => {
    await writeFile(join(dir, '--ext-diff'), 'before\n');
    await writeFile(join(dir, 'other.md'), 'before\n');
    await runGit(['add', '--', '--ext-diff', 'other.md'], dir, {
      env: isolatedGitEnv(globalConfig),
    });
    await runGit(['commit', '-m', 'seed option-like path'], dir, {
      env: isolatedGitEnv(globalConfig),
    });
    await writeFile(join(dir, '--ext-diff'), 'after\n');
    await writeFile(join(dir, 'other.md'), 'after\n');

    const diff = await runGit(['diff', '--', '--ext-diff'], dir, {
      env: isolatedGitEnv(globalConfig),
    });

    expect(diff).toContain('--ext-diff');
    expect(diff).not.toContain('other.md');
  });

  it('re-reads execution config after an explicit transaction-boundary invalidation', async () => {
    const cache = createGitExecutionCache();
    await runGit(['status', '--porcelain'], dir, {
      env: isolatedGitEnv(globalConfig),
      executionCache: cache,
    });
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[filter "probe"]\n\tclean = ${shellCommandPath(probePath)}\n`,
    );

    invalidateGitExecutionCache(cache);
    await writeFile(join(dir, '.gitattributes'), '*.md filter=probe\n');
    await writeFile(join(dir, 'note.md'), 'changed\n');
    await runGit(['add', '.gitattributes', 'note.md'], dir, {
      env: isolatedGitEnv(globalConfig),
      executionCache: cache,
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('re-reads execution config when the config environment changes', async () => {
    const cache = createGitExecutionCache();
    await runGit(['status', '--porcelain'], dir, {
      env: isolatedGitEnv(globalConfig),
      executionCache: cache,
    });
    const secondConfig = join(probeDir, 'second-gitconfig');
    await writeFile(
      secondConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[filter "probe"]\n\tclean = ${shellCommandPath(probePath)}\n`,
    );
    await writeFile(join(dir, '.gitattributes'), '*.md filter=probe\n');
    await writeFile(join(dir, 'note.md'), 'changed\n');

    await runGit(['add', '.gitattributes', 'note.md'], dir, {
      env: isolatedGitEnv(secondConfig),
      executionCache: cache,
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('re-reads repository config when a reused cache switches GIT_DIR', async () => {
    const otherRepo = await mkdtemp(join(probeDir, 'other-repo-'));
    await runGit(['init', '.'], otherRepo, { env: isolatedGitEnv(globalConfig) });
    await runGit(
      ['config', 'filter.probe.clean', shellCommandPath(probePath)],
      otherRepo,
      { env: isolatedGitEnv(globalConfig) },
    );
    const cache = createGitExecutionCache();
    await runGit(['status', '--porcelain'], dir, {
      env: {
        ...isolatedGitEnv(globalConfig),
        GIT_DIR: join(dir, '.git'),
        GIT_WORK_TREE: dir,
      },
      executionCache: cache,
    });
    await writeFile(join(dir, '.gitattributes'), '*.md filter=probe\n');
    await writeFile(join(dir, 'note.md'), 'changed\n');

    await runGit(['add', '.gitattributes', 'note.md'], dir, {
      env: {
        ...isolatedGitEnv(globalConfig),
        GIT_DIR: join(otherRepo, '.git'),
        GIT_WORK_TREE: dir,
      },
      executionCache: cache,
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('keeps a newer cache entry when an overlapping older probe fails', async () => {
    const cache = createGitExecutionCache();
    const missingDir = join(probeDir, 'missing-worktree');

    const [failed, succeeded] = await Promise.allSettled([
      runGit(['status', '--porcelain'], missingDir, {
        env: isolatedGitEnv(globalConfig),
        executionCache: cache,
      }),
      runGit(['status', '--porcelain'], dir, {
        env: isolatedGitEnv(globalConfig),
        executionCache: cache,
      }),
    ]);

    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
    expect(cache.cwd).toBe(dir);
    expect(cache.overrides).toBeDefined();
  });

  it('neutralizes diff.external even when format-patch explicitly enables external diffs', async () => {
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[commit]\n\tgpgsign = false\n[diff]\n\texternal = ${shellCommandPath(probePath)}\n`,
    );
    await writeFile(join(dir, 'note.md'), 'before\n');
    await runGit(['add', 'note.md'], dir, { env: isolatedGitEnv(globalConfig) });
    await runGit(['commit', '-m', 'seed'], dir, { env: isolatedGitEnv(globalConfig) });

    await runGit(['format-patch', '--stdout', '--ext-diff', '-1'], dir, {
      env: isolatedGitEnv(globalConfig),
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run a filter command selected by host attributes and config', async () => {
    const attributesPath = join(probeDir, 'attributes');
    await writeFile(attributesPath, '*.md filter=probe\n');
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[core]\n\tattributesFile = ${gitConfigPath(attributesPath)}\n[filter "probe"]\n\tclean = ${shellCommandPath(probePath)}\n`,
    );
    await writeFile(join(dir, 'note.md'), 'body\n');

    await runGit(['add', 'note.md'], dir, { env: isolatedGitEnv(globalConfig) });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run a host filter command selected by an in-tree .gitattributes', async () => {
    await writeFile(join(dir, '.gitattributes'), '*.md filter=probe\n');
    await writeFile(
      globalConfig,
      `[user]\n\tname = Probe\n\temail = probe@test.local\n[filter "probe"]\n\tclean = ${shellCommandPath(probePath)}\n`,
    );
    await writeFile(join(dir, 'note.md'), 'body\n');

    await runGit(['add', '.gitattributes', 'note.md'], dir, {
      env: isolatedGitEnv(globalConfig),
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run an explicitly supplied ext transport command', async () => {
    await runGit(['ls-remote', `ext::${gitConfigPath(probePath)}`], dir, {
      env: isolatedGitEnv(globalConfig),
    }).catch(() => {});

    expect(existsSync(markerPath)).toBe(false);
  });

  it('rejects a leading protected -c override before it can enable an ext transport', async () => {
    const err: unknown = await runGit(
      [
        '-c',
        'protocol.ext.allow=always',
        'ls-remote',
        `ext::${gitConfigPath(probePath)}`,
      ],
      dir,
      { env: isolatedGitEnv(globalConfig) },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toContain('protocol.ext.allow');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not inherit ambient GIT_DIR redirection from the server process', async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(probeDir, 'not-the-repository');
    try {
      expect(
        gitConfigPath(
          await runGit(['rev-parse', '--show-toplevel'], dir, {
            env: isolatedGitEnv(globalConfig),
          }),
        ),
      ).toBe(
        gitConfigPath(await realpath(dir)),
      );
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});
