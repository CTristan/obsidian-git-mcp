import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, SEED_NOTES, type Fixture } from '../fixture.js';
import { callTool, startServer, type TestServer } from '../helpers.js';

describe('startup reconciliation', () => {
  let fx: Fixture;
  let srv: TestServer | undefined;

  beforeEach(async () => {
    fx = await createFixture();
    srv = undefined;
  });

  afterEach(async () => {
    await srv?.close();
    await fx.cleanup();
  });

  it('resets uncommitted debris to origin/main', async () => {
    await writeFile(join(fx.serverDir, 'Projects/Alpha.md'), 'clobbered by a crash\n');
    await writeFile(join(fx.serverDir, 'Junk.md'), 'junk left mid-transaction\n');

    srv = await startServer(fx);

    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
    const alpha = await readFile(join(fx.serverDir, 'Projects/Alpha.md'), 'utf8');
    expect(alpha).toBe(SEED_NOTES['Projects/Alpha.md']);
    expect(existsSync(join(fx.serverDir, 'Junk.md'))).toBe(false);
  });

  it('clears an orphaned lockfile so a crashed process cannot block writes forever', async () => {
    // A process that dies mid-transaction leaves its lockfile behind; the lock lives
    // in .git/ so tree recovery never touches it. An unparseable holder counts as
    // dead, so startup clears the lock.
    await writeFile(join(fx.serverDir, '.git', 'obsidian-git-mcp.lock'), 'crashed mid-write\n');
    await writeFile(join(fx.serverDir, 'Junk.md'), 'crash debris\n');

    srv = await startServer(fx);

    const res = await callTool(srv.client, 'write_note', {
      path: 'Inbox/AfterCrash.md',
      content: '# After\n',
    });
    expect(res.isError).toBeFalsy();
  });

  it('refuses to start when the lock is held by a live process', async () => {
    // A live holder means another server is writing this checkout (rolling-restart
    // overlap); ripping out its lock and resetting the tree would corrupt that
    // transaction, so startup must fail instead. Our own pid is guaranteed alive.
    await writeFile(
      join(fx.serverDir, '.git', 'obsidian-git-mcp.lock'),
      `pid ${process.pid} at test\n`,
    );

    await expect(startServer(fx)).rejects.toThrow(/lock.*live pid/i);
  });

  it('discards an unpushed local commit', async () => {
    await writeFile(join(fx.serverDir, 'Unacked.md'), 'committed but never pushed\n');
    await git(['add', '-A'], fx.serverDir);
    await git(['commit', '-m', 'crash: unpushed'], fx.serverDir);

    srv = await startServer(fx);

    const head = await git(['rev-parse', 'HEAD'], fx.serverDir);
    const remoteHead = await git(['rev-parse', 'main'], fx.bareDir);
    expect(head).toBe(remoteHead);
    expect(existsSync(join(fx.serverDir, 'Unacked.md'))).toBe(false);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });
});
