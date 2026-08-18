import { join } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import {
  callTool,
  commitShaOf,
  startServer,
  textOf,
  type TestServer,
} from '../helpers.js';

describe('prepared mobile writes', () => {
  let fx: Fixture;
  let srv: TestServer;

  beforeEach(async () => {
    fx = await createFixture();
    srv = await startServer(fx, {
      accessMode: 'prepared',
      operationStateDir: join(fx.root, 'operations'),
    });
  });

  afterEach(async () => {
    await srv.close();
    await fx.cleanup();
  });

  it('lists annotated reads and prepared tools without direct mutations', async () => {
    const { tools } = await srv.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has('read_note')).toBe(true);
    expect(byName.has('prepare_vault_change')).toBe(true);
    expect(byName.has('execute_vault_change')).toBe(true);
    expect(byName.has('get_vault_operation')).toBe(true);
    expect(byName.has('vault_health')).toBe(true);

    for (const hidden of [
      'write_note',
      'patch_note',
      'update_frontmatter',
      'manage_tags',
      'append_to_section',
      'delete_note',
      'move_note',
      'move_file',
    ]) {
      expect(byName.has(hidden), `${hidden} must stay hidden`).toBe(false);
    }

    expect(byName.get('read_note')?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(byName.get('execute_vault_change')?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });

    const bypass = await callTool(srv.client, 'write_note', {
      path: 'Inbox/Bypass.md',
      content: '# Bypass\n',
    });
    expect(bypass.isError).toBe(true);
    expect(textOf(bypass)).toContain('unavailable in prepared mode');

    const health = await callTool(srv.client, 'vault_health', {});
    expect(health.isError, textOf(health)).toBeFalsy();
    expect(JSON.parse(textOf(health))).toMatchObject({ status: 'ok', accessMode: 'prepared' });
  });

  it('previews an exact append before one attributed pushed commit', async () => {
    const before = await fx.bareHead();
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'append_to_section',
      arguments: {
        path: 'Projects/Alpha.md',
        heading: 'Status',
        text: 'Mobile canary.',
      },
    });
    expect(prepared.isError, textOf(prepared)).toBeFalsy();
    expect(await fx.bareHead()).toBe(before);

    const preview = JSON.parse(textOf(prepared)) as {
      requestId: string;
      baseHeadSha: string;
      digest: string;
      affectedPaths: string[];
      preview: string;
      status: string;
    };
    expect(preview.status).toBe('prepared');
    expect(preview.baseHeadSha).toBe(before);
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.affectedPaths).toEqual(['Projects/Alpha.md']);
    expect(preview.preview).toContain('+Mobile canary.');

    const executed = await callTool(srv.client, 'execute_vault_change', {
      requestId: preview.requestId,
    });
    expect(executed.isError, textOf(executed)).toBeFalsy();
    const sha = commitShaOf(executed);
    expect(sha).toBe(await fx.bareHead());
    expect(await fx.remoteFile('Projects/Alpha.md')).toContain('Mobile canary.');

    const message = await git(['log', '-1', '--format=%B', 'main'], fx.bareDir);
    expect(message).toContain(`Vault-Request-Id: ${preview.requestId}`);
    expect(message).toContain(`Vault-Operation-Digest: ${preview.digest}`);
    expect(message).toContain('Vault-Actor: Test Agent');
  });

  it('replays a completed append without another commit or duplicate text', async () => {
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'append_to_section',
      arguments: {
        path: 'Projects/Alpha.md',
        heading: 'Status',
        text: 'Replay-safe canary.',
      },
    });
    const requestId = (JSON.parse(textOf(prepared)) as { requestId: string }).requestId;

    const first = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(first.isError, textOf(first)).toBeFalsy();
    const firstHead = await fx.bareHead();

    const replay = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(replay.isError, textOf(replay)).toBeFalsy();
    expect(commitShaOf(replay)).toBe(firstHead);
    expect(await fx.bareHead()).toBe(firstHead);
    expect((await fx.remoteFile('Projects/Alpha.md')).match(/Replay-safe canary\./g)).toHaveLength(1);
  });

  it('coalesces concurrent execution retries into one pushed commit', async () => {
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'append_to_section',
      arguments: {
        path: 'Projects/Alpha.md',
        heading: 'Status',
        text: 'Concurrent canary.',
      },
    });
    const requestId = (JSON.parse(textOf(prepared)) as { requestId: string }).requestId;

    const [left, right] = await Promise.all([
      callTool(srv.client, 'execute_vault_change', { requestId }),
      callTool(srv.client, 'execute_vault_change', { requestId }),
    ]);
    expect(left.isError, textOf(left)).toBeFalsy();
    expect(right.isError, textOf(right)).toBeFalsy();
    expect(commitShaOf(left)).toBe(commitShaOf(right));
    expect((await fx.remoteFile('Projects/Alpha.md')).match(/Concurrent canary\./g)).toHaveLength(1);
  });

  it('recovers a pushed operation when the process stops before recording success', async () => {
    await srv.close();
    let interrupted = false;
    srv = await startServer(fx, {
      accessMode: 'prepared',
      operationStateDir: join(fx.root, 'operations'),
      testHooks: {
        afterPreparedPush: async () => {
          if (!interrupted) {
            interrupted = true;
            throw new Error('simulated process interruption');
          }
        },
      },
    });
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'append_to_section',
      arguments: {
        path: 'Projects/Alpha.md',
        heading: 'Status',
        text: 'Recovered canary.',
      },
    });
    const requestId = (JSON.parse(textOf(prepared)) as { requestId: string }).requestId;

    const interruptedResult = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(interruptedResult.isError).toBe(true);
    expect(textOf(interruptedResult)).toContain('simulated process interruption');
    const pushedHead = await fx.bareHead();

    await srv.close();
    srv = await startServer(fx, {
      accessMode: 'prepared',
      operationStateDir: join(fx.root, 'operations'),
    });
    const recovered = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(recovered.isError, textOf(recovered)).toBeFalsy();
    expect(commitShaOf(recovered)).toBe(pushedHead);
    expect(await fx.bareHead()).toBe(pushedHead);
    expect((await fx.remoteFile('Projects/Alpha.md')).match(/Recovered canary\./g)).toHaveLength(1);
  });

  it('refuses a prepared change when the remote base advances', async () => {
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'patch_note',
      arguments: {
        path: 'Projects/Alpha.md',
        oldString: 'Alpha is in flight.',
        newString: 'Alpha changed from mobile.',
      },
    });
    const requestId = (JSON.parse(textOf(prepared)) as { requestId: string }).requestId;

    await fx.collabWrite('Inbox/Remote.md', '# Remote\n', 'Advance remote');
    const executed = await callTool(srv.client, 'execute_vault_change', { requestId });

    expect(executed.isError).toBe(true);
    expect(textOf(executed)).toContain('stale');
    expect(await fx.remoteFile('Projects/Alpha.md')).toContain('Alpha is in flight.');
  });

  it('refuses overwrite-capable and unknown prepared arguments', async () => {
    const overwrite = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'create_note',
      arguments: {
        path: 'Projects/Alpha.md',
        content: '# Replacement\n',
      },
    });
    expect(overwrite.isError).toBe(true);
    expect(textOf(overwrite)).toContain('already exists');

    const extra = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'create_note',
      arguments: {
        path: 'Inbox/New.md',
        content: '# New\n',
        mode: 'append',
      },
    });
    expect(extra.isError).toBe(true);
    expect(textOf(extra)).toContain('unsupported argument');
  });

  it('expires prepared records and protects their owner-only ledger', async () => {
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'create_note',
      arguments: { path: 'Inbox/Expiring.md', content: '# Expiring\n' },
    });
    const { requestId } = JSON.parse(textOf(prepared)) as { requestId: string };
    const stateDir = join(fx.root, 'operations');
    const statePath = join(stateDir, `${requestId}.json`);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(statePath, 'utf8')) as { expiresAt: string };
    record.expiresAt = new Date(0).toISOString();
    await writeFile(statePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    const expired = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(expired.isError).toBe(true);
    expect(textOf(expired)).toContain('expired');
    expect(await fx.bareLog('%s', 1)).toEqual(['Seed vault']);
  });

  it('refuses a locally altered operation record before mutation', async () => {
    const prepared = await callTool(srv.client, 'prepare_vault_change', {
      operation: 'create_note',
      arguments: { path: 'Inbox/Original.md', content: '# Original\n' },
    });
    const { requestId } = JSON.parse(textOf(prepared)) as { requestId: string };
    const statePath = join(fx.root, 'operations', `${requestId}.json`);
    const record = JSON.parse(await readFile(statePath, 'utf8')) as {
      arguments: Record<string, unknown>;
    };
    record.arguments['path'] = 'Inbox/Altered.md';
    await writeFile(statePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    const refused = await callTool(srv.client, 'execute_vault_change', { requestId });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('integrity check');
    expect(await fx.bareLog('%s', 1)).toEqual(['Seed vault']);
  });
});
