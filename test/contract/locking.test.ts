import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
  expectCleanCheckout,
  startServer,
  textOf,
  type TestServer,
} from '../helpers.js';

describe('locking', () => {
  let fx: Fixture;
  let srv: TestServer;

  beforeEach(async () => {
    fx = await createFixture();
    srv = await startServer(fx);
  });

  afterEach(async () => {
    await srv.close();
    await fx.cleanup();
  });

  it('two simultaneous writes serialize into two clean commits', async () => {
    const [a, b] = await Promise.all([
      callTool(srv.client, 'write_note', { path: 'Inbox/A.md', content: '# A\n' }),
      callTool(srv.client, 'write_note', { path: 'Inbox/B.md', content: '# B\n' }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();

    const shas = await fx.bareLog('%H', 2);
    expect(new Set(shas)).toEqual(new Set([commitShaOf(a), commitShaOf(b)]));
    // Linear history: the newer commit's parent is the older one.
    const parentOfHead = await git(['rev-parse', 'main~1'], fx.bareDir);
    expect(shas[1]).toBe(parentOfHead);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });

  it('a foreign lockfile blocks writes with a clear error, and release unblocks', async () => {
    const lockPath = join(fx.serverDir, '.git', 'obsidian-git-mcp.lock');
    await writeFile(lockPath, `pid ${process.pid}\n`);

    const blocked = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Blocked.md',
      content: '# Blocked\n',
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked).toLowerCase()).toContain('lock');
    await expectCleanCheckout(fx);

    await rm(lockPath);
    const ok = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Blocked.md',
      content: '# Blocked\n',
    });
    expect(ok.isError).toBeFalsy();
  });
});
