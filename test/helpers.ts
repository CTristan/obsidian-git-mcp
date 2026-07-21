import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createVaultServer, type VaultServerConfig } from '../src/index.js';
import type { Fixture } from './fixture.js';

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
  await server.connect(serverTransport);
  const client = new Client({ name: 'contract-tests', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
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
