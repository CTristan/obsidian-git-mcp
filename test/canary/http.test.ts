import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanaryCatalogFromDocuments } from '../../src/canary/catalog.js';
import { createCanaryHttpServer } from '../../src/canary/http.js';

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function runningServer() {
  const catalog = createCanaryCatalogFromDocuments([
    {
      id: 'mobile-proof',
      text: '# Mobile proof\n\nThe canary is available.\n',
      title: 'Mobile proof',
      url: 'http://127.0.0.1/notes/mobile-proof',
    },
  ]);
  const server = createCanaryHttpServer({
    allowedHosts: ['127.0.0.1'],
    catalog,
    domainChallenge: 'challenge-token',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  closers.push(async () => {
    server.close();
    await once(server, 'close');
  });
  return { origin };
}

describe('canary HTTP service', () => {
  it('serves health, citations, legal pages, and domain verification without auth', async () => {
    const { origin } = await runningServer();

    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const note = await fetch(`${origin}/notes/mobile-proof`);
    expect(note.status).toBe(200);
    expect(await note.text()).toContain('The canary is available.');

    for (const path of ['/privacy', '/terms', '/support']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    }

    const challenge = await fetch(`${origin}/.well-known/openai-apps-challenge`);
    expect(await challenge.text()).toBe('challenge-token');
  });

  it('completes the stateless Streamable HTTP MCP loop', async () => {
    const { origin } = await runningServer();
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
    const client = new Client({ name: 'canary-http-test', version: '0.0.0' });
    closers.push(() => client.close());

    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
  });
});
