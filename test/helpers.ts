import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';
import { createVaultServer, type VaultServerConfig } from '../src/index.js';
import { git, type Fixture } from './fixture.js';

export interface TestServer {
  client: Client;
  close(): Promise<void>;
}

export const TEST_COLLABORATOR = { name: 'Test Agent', email: 'agent@test.local' };
export const SERVICE_NAME = 'obsidian-git-mcp';
export const SERVICE_EMAIL = 'service@obsidian-git-mcp.local';

/** Boot the server under test against the fixture checkout and hand back a connected MCP client. */
export async function startServer(
  fixture: Fixture,
  overrides: Partial<VaultServerConfig> = {},
): Promise<TestServer> {
  const server = await createVaultServer({
    vaultPath: fixture.serverDir,
    collaborator: TEST_COLLABORATOR,
    // Zero throttle so read-freshness behavior is deterministic in tests.
    readFreshnessMs: 0,
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-tests', version: '0.0.0' });
  // A connect failure would otherwise leak the already-created server (and its
  // startup-reconciled checkout state) into the rest of the test run.
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }
  return {
    client,
    async close() {
      // finally, not sequential awaits: the server must close even when the client's
      // close rejects, or one bad test poisons every later fixture.
      try {
        await client.close();
      } finally {
        await server.close();
      }
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** Concatenated text content of a tool result. */
export function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export function commitShaOf(result: CallToolResult): string {
  return String((result._meta ?? {})['commitSha'] ?? '');
}

export function headShaOf(result: CallToolResult): string {
  return String((result._meta ?? {})['headSha'] ?? '');
}

/** Snapshot the checkout HEAD and remote tip before an expected-failure write, so the rollback can be asserted against the pre-write state. */
export async function snapshot(fx: Fixture): Promise<{ preHead: string; preRemote: string }> {
  const preHead = await git(['rev-parse', 'HEAD'], fx.serverDir);
  const preRemote = await fx.bareHead();
  return { preHead, preRemote };
}

/** The refusal must roll the local checkout back too, not just leave the remote alone. */
export async function expectRolledBack(fx: Fixture, preRemote: string, preHead: string): Promise<void> {
  expect(await fx.bareHead()).toBe(preRemote);
  expect(await git(['rev-parse', 'HEAD'], fx.serverDir)).toBe(preHead);
  expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
}
