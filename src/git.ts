import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Matches the userinfo section of a URL ("https://user:token@host"), because a vault
// remote may embed credentials and git happily echoes such URLs into its own stderr.
const CREDENTIAL_URL = /:\/\/[^/@\s]+@/g;

function redact(value: string): string {
  return value.replaceAll(CREDENTIAL_URL, '://***@');
}

export class GitError extends Error {
  override name = 'GitError';

  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | undefined;

  // Redaction lives in the constructor, not at the throw site, so every surface a
  // consumer might log — message, args, stderr — is covered no matter who constructs
  // the error. GitError is re-exported from the package root and its message can reach
  // MCP tool responses, which makes an unredacted token a disclosure, not a debug aid.
  constructor(message: string, args: string[], stderr: string, exitCode?: number) {
    super(redact(message));
    this.args = args.map(redact);
    this.stderr = redact(stderr);
    this.exitCode = exitCode;
  }
}

export interface GitOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  executionCache?: GitExecutionCache;
}

export interface GitExecutionCache {
  cwd?: string;
  configEnvKey?: string;
  overrides?: Promise<string[]>;
}

export function createGitExecutionCache(): GitExecutionCache {
  return {};
}

export function invalidateGitExecutionCache(cache: GitExecutionCache): void {
  delete cache.cwd;
  delete cache.configEnvKey;
  delete cache.overrides;
}

interface HardeningState {
  dir: string;
  args: string[];
}

let hardeningState: HardeningState | undefined;

function hardenedConfig(): string[] {
  if (hardeningState !== undefined) return hardeningState.args;

  // Create hardening state only when a git call actually runs, so importing the package
  // root for a pure helper has no filesystem side effect.
  const dir = mkdtempSync(join(tmpdir(), 'ogm-git-hardening-'));
  const hooksDir = join(dir, 'hooks');
  const attributesFile = join(dir, 'attributes');
  mkdirSync(hooksDir, { mode: 0o700 });
  writeFileSync(attributesFile, '');
  const forward = (value: string): string => value.replaceAll('\\', '/');
  const args = [
    '--no-pager',
    '-c',
    `core.hooksPath=${forward(hooksDir)}`,
    '-c',
    `core.attributesFile=${forward(attributesFile)}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.ext.allow=never',
  ];
  hardeningState = { dir, args };

  // The 'exit' handler must be synchronous — Node discards queued async work once teardown
  // begins. Cleanup stays best-effort because SIGKILL can strand a harmless private dir.
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return args;
}

function gitEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    ...overrides,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

const EXECUTION_CONFIG =
  '^(diff\\.external|filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(command|textconv))$';

async function configuredExecutionOverrides(
  cwd: string,
  env: NodeJS.ProcessEnv,
  base: string[],
): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'git',
      [...base, 'config', '--null', '--get-regexp', EXECUTION_CONFIG],
      { cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (err) {
    // git config exits 1 when no key matches; every other failure is real.
    if ((err as { code?: number }).code === 1) return [];
    throw err;
  }

  const keys = stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(0, entry.indexOf('\n')))
    .filter((key) => key !== '');
  const overrides: string[] = [];
  for (const key of new Set(keys)) {
    overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return overrides;
}

async function cachedExecutionOverrides(
  cwd: string,
  env: NodeJS.ProcessEnv,
  base: string[],
  cache: GitExecutionCache | undefined,
): Promise<string[]> {
  if (cache === undefined) {
    return configuredExecutionOverrides(cwd, env, base);
  }
  const configEnvKey = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(env)
          .filter(
            ([key]) =>
              key.startsWith('GIT_') || key === 'HOME' || key === 'XDG_CONFIG_HOME',
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest('hex');
  if (
    cache.cwd !== cwd ||
    cache.configEnvKey !== configEnvKey ||
    cache.overrides === undefined
  ) {
    cache.cwd = cwd;
    cache.configEnvKey = configEnvKey;
    cache.overrides = configuredExecutionOverrides(cwd, env, base);
  }
  const pending = cache.overrides;
  try {
    return await pending;
  } catch (err) {
    // A newer caller may have installed a different entry while this probe was pending.
    // Only the owner of the rejected promise can clear it.
    if (cache.overrides === pending) invalidateGitExecutionCache(cache);
    throw err;
  }
}

function hardenCommandArgs(args: string[]): string[] {
  const command = args[0];
  const remaining = args.slice(1).filter((arg) => arg !== '--ext-diff' && arg !== '--textconv');
  if (
    command === 'diff' ||
    command === 'log' ||
    command === 'show' ||
    command === 'format-patch'
  ) {
    return [command, '--no-ext-diff', '--no-textconv', ...remaining];
  }
  if (command === 'blame' || command === 'grep') {
    return [command, '--no-textconv', ...remaining];
  }
  return args;
}

/**
 * Run a git command via execFile with an argument array — never a shell string — so
 * note paths and commit messages can't inject anything. GIT_TERMINAL_PROMPT=0 because
 * an unattended server must fail loudly instead of hanging on a credential prompt.
 */
export async function runGit(
  args: string[],
  cwd: string,
  options: GitOptions = {},
): Promise<string> {
  try {
    const base = hardenedConfig();
    const env = gitEnv(options.env);
    const executionOverrides = await cachedExecutionOverrides(
      cwd,
      env,
      base,
      options.executionCache,
    );
    const { stdout } = await exec(
      'git',
      [...base, ...executionOverrides, ...hardenCommandArgs(args)],
      {
        cwd,
        env,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return stdout.replace(/\n$/, '');
  } catch (err) {
    const e = err as {
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
      code?: string | number;
    };
    const detail =
      e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output exceeded the 16 MiB buffer'
        : e.killed
          ? `timed out after ${options.timeoutMs ?? 30_000}ms${e.signal ? ` (${e.signal})` : ''}`
          : e.stderr?.trim() || e.message || 'unknown error';
    throw new GitError(
      `git ${args.join(' ')} failed: ${detail}`,
      args,
      e.stderr ?? '',
      typeof e.code === 'number' ? e.code : undefined,
    );
  }
}
