import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// GIT_CONFIG_GLOBAL/SYSTEM point at /dev/null so fixture git never inherits the host's
// config — a global hook, alias, or signing setting must not change test behavior.
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: FIXTURE_GIT_ENV });
  return stdout.trim();
}

// Every clone gets a local identity and local commit.gpgsign=false, because a test run
// must never depend on the machine's global git config — a global gpgsign=true would
// hang every fixture commit on a hardware-key prompt.
async function configureClone(dir: string, name: string, email: string): Promise<void> {
  await git(['config', 'user.name', name], dir);
  await git(['config', 'user.email', email], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

export const SEED_NOTES: Record<string, string> = {
  'Projects/Alpha.md': [
    '---',
    'tags: [project]',
    'status: active',
    '---',
    '',
    '# Alpha',
    '',
    '## Status',
    '',
    'Alpha is in flight.',
    '',
    '## Decisions',
    '',
    '- Ship early.',
    '',
  ].join('\n'),
  'Inbox/Beta.md': '# Beta\n\nA note about squirrels.\n',
  '.obsidian/app.json': '{"theme":"obsidian"}\n',
};

export interface Fixture {
  root: string;
  /** Bare repository standing in for GitHub. */
  bareDir: string;
  /** The checkout the server under test operates on. */
  serverDir: string;
  /** An independent clone simulating a concurrent human/agent editor. */
  collabDir: string;
  /**
   * A unique temp dir outside the checkout, for absolute-path-escape tests. Its own
   * mkdtemp (not a fixed path like /tmp/evil.md) so concurrent test runs can't collide.
   */
  outsideDir: string;
  /** Commit + push a file from the collaborator clone; returns the new SHA. */
  collabWrite(path: string, content: string, message: string): Promise<string>;
  /** git log of the bare remote's main, newest first. */
  bareLog(format: string, limit?: number): Promise<string[]>;
  /** SHA of the bare remote's main — snapshot before a rejection, compare after. */
  bareHead(): Promise<string>;
  /**
   * Exact bytes of a file on the remote's main. Deliberately avoids the trimming git()
   * helper, because byte-identity assertions must see trailing-newline corruption.
   */
  remoteFile(path: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ogm-'));
  const bareDir = join(root, 'remote.git');
  const seedDir = join(root, 'seed');
  const serverDir = join(root, 'server');
  const collabDir = join(root, 'collab');
  const outsideDir = await mkdtemp(join(tmpdir(), 'ogm-outside-'));

  await mkdir(bareDir);
  await git(['init', '--bare', '-b', 'main', '.'], bareDir);

  // Seed the remote through a scratch clone so server/collab clones start populated.
  await git(['clone', bareDir, seedDir], root);
  await configureClone(seedDir, 'Seeder', 'seeder@fixture.local');
  await git(['checkout', '-b', 'main'], seedDir);
  for (const [path, content] of Object.entries(SEED_NOTES)) {
    await mkdir(join(seedDir, dirname(path)), { recursive: true });
    await writeFile(join(seedDir, path), content);
  }
  await git(['add', '-A'], seedDir);
  await git(['commit', '-m', 'Seed vault'], seedDir);
  await git(['push', 'origin', 'main'], seedDir);

  await git(['clone', bareDir, serverDir], root);
  await configureClone(serverDir, 'Server Fallback', 'server@fixture.local');
  await git(['clone', bareDir, collabDir], root);
  await configureClone(collabDir, 'Collaborator', 'collab@fixture.local');

  return {
    root,
    bareDir,
    serverDir,
    collabDir,
    outsideDir,
    async collabWrite(path, content, message) {
      await git(['pull', '--rebase', 'origin', 'main'], collabDir);
      await mkdir(join(collabDir, dirname(path)), { recursive: true });
      await writeFile(join(collabDir, path), content);
      await git(['add', '-A'], collabDir);
      await git(['commit', '-m', message], collabDir);
      await git(['push', 'origin', 'main'], collabDir);
      return git(['rev-parse', 'HEAD'], collabDir);
    },
    async bareLog(format, limit = 20) {
      const out = await git(['log', `--format=${format}`, '-n', String(limit), 'main'], bareDir);
      return out === '' ? [] : out.split('\n');
    },
    bareHead() {
      return git(['rev-parse', 'main'], bareDir);
    },
    async remoteFile(path) {
      const { stdout } = await exec('git', ['cat-file', 'blob', `main:${path}`], {
        cwd: bareDir,
        env: FIXTURE_GIT_ENV,
      });
      return stdout;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    },
  };
}
