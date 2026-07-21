import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, startServer, textOf, type TestServer } from '../helpers.js';

describe('destructive tools', () => {
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

  it('destructive tools are hidden and refused by default', async () => {
    srv = await startServer(fx);
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('delete_note');
    expect(names).not.toContain('move_note');
    expect(names).not.toContain('move_file');

    const res = await callTool(srv.client, 'delete_note', { path: 'Inbox/Beta.md' });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('disabled');
    // The note is still on the remote.
    expect(await git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).toContain('squirrels');
  });

  it('move_note works when destructive tools are enabled', async () => {
    srv = await startServer(fx, { allowDestructive: true });
    const { tools } = await srv.client.listTools();
    expect(tools.map((t) => t.name)).toContain('move_note');

    const res = await callTool(srv.client, 'move_note', {
      oldPath: 'Inbox/Beta.md',
      newPath: 'Archive/Beta.md',
    });
    expect(res.isError).toBeFalsy();

    expect(await git(['show', 'main:Archive/Beta.md'], fx.bareDir)).toContain('squirrels');
    await expect(git(['show', 'main:Inbox/Beta.md'], fx.bareDir)).rejects.toThrow();
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });
});
