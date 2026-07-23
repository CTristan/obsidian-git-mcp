import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, commitShaOf, startServer, textOf, type TestServer } from '../helpers.js';

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

  it('every listed tool is callable — listing never exceeds the classified sets', async () => {
    // If an MCPVault upgrade adds a tool we haven't classified, it must stay hidden
    // rather than being listed and then failing every call as "unknown tool". This
    // pin fails on upgrade until the new tool is classified.
    const KNOWN = new Set([
      'read_note',
      'read_multiple_notes',
      'search_notes',
      'list_directory',
      'get_frontmatter',
      'get_notes_info',
      'get_vault_stats',
      'list_all_tags',
      'write_note',
      'patch_note',
      'update_frontmatter',
      'manage_tags',
      'vault_status',
      'list_recent_changes',
      'append_to_section',
    ]);
    const { tools } = await srv.client.listTools();
    for (const tool of tools) {
      expect(KNOWN.has(tool.name), `unclassified tool listed: ${tool.name}`).toBe(true);
    }
  });

  it('the tools no other test exercises are callable with valid arguments', async () => {
    // The classification pin above checks names; this checks the listed tools the rest
    // of the suite never invokes actually work when called.
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_frontmatter', { path: 'Projects/Alpha.md' }],
      ['get_notes_info', { paths: ['Projects/Alpha.md'] }],
      ['get_vault_stats', {}],
      ['list_all_tags', {}],
    ];
    for (const [name, args] of calls) {
      const res = await callTool(srv.client, name, args);
      expect(res.isError, `${name} failed: ${textOf(res)}`).toBeFalsy();
    }

    const listing = await callTool(srv.client, 'list_directory', { path: 'Projects' });
    expect(listing.isError, `list_directory failed: ${textOf(listing)}`).toBeFalsy();
    const parsed = JSON.parse(textOf(listing)) as { files: string[]; dirs: string[] };
    expect(parsed.files).toContain('Alpha.md');
  });

  it('manage_tags lands a pushed commit and returns its SHA', async () => {
    const before = await fx.bareHead();
    const res = await callTool(srv.client, 'manage_tags', {
      path: 'Projects/Alpha.md',
      operation: 'add',
      tags: ['spike'],
    });
    expect(res.isError, `manage_tags failed: ${textOf(res)}`).toBeFalsy();
    const after = await fx.bareHead();
    expect(after).not.toBe(before);
    expect(commitShaOf(res)).toBe(after);
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

  it('list_recent_changes truncates a fractional limit instead of erroring', async () => {
    await callTool(srv.client, 'write_note', { path: 'Inbox/A.md', content: '# A\n' });
    await callTool(srv.client, 'write_note', { path: 'Inbox/B.md', content: '# B\n' });
    const res = await callTool(srv.client, 'list_recent_changes', { limit: 2.7 });
    expect(res.isError, `expected success, got: ${textOf(res)}`).toBeFalsy();
    // 2.7 floors to 2, so exactly the two newest commits are returned, newest first.
    const changes = textOf(res).trim().split('\n');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain('Inbox/B.md');
    expect(changes[1]).toContain('Inbox/A.md');
  });

  it('list_recent_changes clamps an explicit limit of 0 to the documented minimum of 1', async () => {
    await callTool(srv.client, 'write_note', { path: 'Inbox/Newest.md', content: '# Newest\n' });
    const res = await callTool(srv.client, 'list_recent_changes', { limit: 0 });
    expect(res.isError, `expected success, got: ${textOf(res)}`).toBeFalsy();
    const lines = textOf(res).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Inbox/Newest.md');
  });
});
