import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Server-side git must never execute host-configured hook code: a global or system
// core.hooksPath makes every fetch/push/commit run arbitrary host hooks. A command-line -c
// outranks every config layer, so we redirect core.hooksPath to an empty directory we create
// and own. Git resolves a hook by probing <hooksPath>/<hookname>, finds nothing in an empty
// dir, and runs no hook — and that holds identically on Windows, macOS, and Linux, which
// /dev/null does not: Git for Windows can read /dev/null as a literal relative path and even
// create a dev/null directory rather than treating it as the null device. We forward-slash the
// path because git parses a -c value like a config-file value, where a Windows temp path's
// backslashes would read as escape sequences. Wiping global/system config wholesale isn't an
// option — that would drop the user's credential.helper and break authenticated pushes.
const EMPTY_HOOKS_DIR = mkdtempSync(join(tmpdir(), 'ogm-nohooks-')).replaceAll('\\', '/');
const EMPTY_ATTRIBUTES_FILE = `${EMPTY_HOOKS_DIR}/attributes`;
writeFileSync(EMPTY_ATTRIBUTES_FILE, '');
const HARDENED_CONFIG = [
  '--no-pager',
  '-c',
  `core.hooksPath=${EMPTY_HOOKS_DIR}`,
  '-c',
  `core.attributesFile=${EMPTY_ATTRIBUTES_FILE}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
];

// The 'exit' handler must be synchronous — Node discards queued async work once teardown
// begins — so cleanup is rmSync, not rm. It stays best-effort because 'exit' never fires on
// SIGKILL or a hard crash, and a stranded empty dir is harmless, so a failed removal must
// not mask the real exit reason.
process.once('exit', () => {
  try {
    rmSync(EMPTY_HOOKS_DIR, { recursive: true, force: true });
  } catch {}
});

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
    const { stdout } = await exec('git', [...HARDENED_CONFIG, ...args], {
      cwd,
      // These forced values come last so no caller can re-enable interactive prompts or
      // system-level attributes that select host-configured filter/textconv commands.
      env: {
        ...process.env,
        ...options.env,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_EXTERNAL_DIFF: '',
        GIT_TERMINAL_PROMPT: '0',
      },
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
