import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, SEED_NOTES, type Fixture } from '../fixture.js';
import { startServer, type TestServer } from '../helpers.js';

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
