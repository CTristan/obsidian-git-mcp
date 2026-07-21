import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitError extends Error {
  override name = 'GitError';

  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitOptions {
  env?: Record<string, string>;
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
    const { stdout } = await exec('git', args, {
      cwd,
      // GIT_TERMINAL_PROMPT last so no caller can re-enable interactive prompts.
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.replace(/\n$/, '');
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || 'unknown error';
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`, args, e.stderr ?? '');
  }
}
