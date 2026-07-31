import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanaryCatalogFromDocuments } from '../../src/canary/catalog.js';
import { createCanaryMcpServer } from '../../src/canary/server.js';

const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

async function connectedClient() {
  const catalog = createCanaryCatalogFromDocuments([
    {
      id: 'mobile-proof',
      text: '# Mobile proof\n\nThe canary phrase is saffron-orbit-7f3c2a91.\n',
      title: 'Mobile proof',
      url: 'https://vault-poc.example.com/notes/mobile-proof',
    },
    {
      id: 'safety',
      text: '# Safety\n\nWrites are outside this read-only service.\n',
      title: 'Safety',
      url: 'https://vault-poc.example.com/notes/safety',
    },
  ]);
  const server = createCanaryMcpServer(catalog);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'canary-test', version: '0.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function onlyText(result: Awaited<ReturnType<Client['callTool']>>) {
  const contentItems = result.content as Array<{ type: string; text?: string }>;
  expect(contentItems).toHaveLength(1);
  const content = contentItems[0];
  expect(content?.type).toBe('text');
  if (content?.type !== 'text' || content.text === undefined) {
    throw new Error('expected one text content item');
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe('canary MCP tools', () => {
  it('advertises only standard retry-safe read tools', async () => {
    const { client, server } = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      });
    }
    await server.close();
  });

  it('returns the standard search result shape in one text content item', async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({ name: 'search', arguments: { query: 'canary phrase' } });

    expect(onlyText(result)).toEqual({
      results: [
        {
          id: 'mobile-proof',
          title: 'Mobile proof',
          url: 'https://vault-poc.example.com/notes/mobile-proof',
        },
      ],
    });
    await server.close();
  });

  it('returns exact Markdown through the standard fetch result shape', async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({ name: 'fetch', arguments: { id: 'mobile-proof' } });

    expect(onlyText(result)).toEqual({
      id: 'mobile-proof',
      metadata: { format: 'text/markdown' },
      text: '# Mobile proof\n\nThe canary phrase is saffron-orbit-7f3c2a91.\n',
      title: 'Mobile proof',
      url: 'https://vault-poc.example.com/notes/mobile-proof',
    });
    await server.close();
  });

  it('reports unknown document IDs as tool errors without approximating', async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({ name: 'fetch', arguments: { id: 'missing' } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'No document exists with the ID "missing".' },
    ]);
    await server.close();
  });
});
