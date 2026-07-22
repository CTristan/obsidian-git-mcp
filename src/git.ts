import { execFile } from 'node:child_process';
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

  // Redaction lives in the constructor, not at the throw site, so every surface a
  // consumer might log — message, args, stderr — is covered no matter who constructs
  // the error. GitError is re-exported from the package root and its message can reach
  // MCP tool responses, which makes an unredacted token a disclosure, not a debug aid.
  constructor(message: string, args: string[], stderr: string) {
    super(redact(message));
    this.args = args.map(redact);
    this.stderr = redact(stderr);
  }
}

export interface GitOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
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
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.replace(/\n$/, '');
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || 'unknown error';
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`, args, e.stderr ?? '');
  }
}
