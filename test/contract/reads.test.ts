import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, headShaOf, startServer, textOf, type TestServer } from '../helpers.js';

describe('reads', () => {
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

  it('search_notes finds a seeded note by content', async () => {
    const res = await callTool(srv.client, 'search_notes', { query: 'squirrels' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Beta');
  });

  it('read_note returns seeded content and stamps the checkout HEAD SHA', async () => {
    const res = await callTool(srv.client, 'read_note', { path: 'Projects/Alpha.md' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Alpha is in flight.');
    const head = await git(['rev-parse', 'HEAD'], fx.serverDir);
    expect(headShaOf(res)).toBe(head);
  });

  it('read_multiple_notes returns both seeded notes', async () => {
    const res = await callTool(srv.client, 'read_multiple_notes', {
      paths: ['Projects/Alpha.md', 'Inbox/Beta.md'],
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('Alpha is in flight.');
    expect(text).toContain('squirrels');
  });

  it('reads degrade to last-known state when the remote is unreachable', async () => {
    // Local-first: a transient remote outage must not fail reads — they serve the
    // last consistent state and the next write surfaces the problem.
    await git(['remote', 'set-url', 'origin', '/nonexistent/nowhere.git'], fx.serverDir);
    const res = await callTool(srv.client, 'read_note', { path: 'Projects/Alpha.md' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Alpha is in flight.');
  });

  it('read_note reflects a collaborator push made after startup', async () => {
    await fx.collabWrite('Inbox/Gamma.md', '# Gamma\n\nFresh from another agent.\n', 'collab: add Gamma');
    const res = await callTool(srv.client, 'read_note', { path: 'Inbox/Gamma.md' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Fresh from another agent.');
  });
});
