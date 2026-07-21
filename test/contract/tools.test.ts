import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, startServer, textOf, type TestServer } from '../helpers.js';

describe('wrapper-added tools', () => {
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

  it('vault_status reports HEAD, branch, and clean state', async () => {
    const res = await callTool(srv.client, 'vault_status', {});
    expect(res.isError).toBeFalsy();
    const status = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(status['headSha']).toBe(await git(['rev-parse', 'HEAD'], fx.serverDir));
    expect(status['branch']).toBe('main');
    expect(status['dirty']).toBe(false);
    expect(status['ahead']).toBe(0);
    expect(status['behind']).toBe(0);
  });

  it('list_recent_changes returns newest-first git history', async () => {
    await callTool(srv.client, 'write_note', { path: 'Inbox/Newest.md', content: '# Newest\n' });
    const res = await callTool(srv.client, 'list_recent_changes', { limit: 10 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('Seed vault');
    expect(text).toContain('Inbox/Newest.md');
    // Newest first: the write appears before the seed commit.
    expect(text.indexOf('Inbox/Newest.md')).toBeLessThan(text.indexOf('Seed vault'));
  });
});
