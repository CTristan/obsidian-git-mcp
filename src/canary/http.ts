import { createServer, type Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import type { CanaryCatalog } from './catalog.js';
import { createCanaryMcpServer } from './server.js';

export interface CanaryHttpOptions {
  allowedHosts: string[];
  catalog: CanaryCatalog;
  domainChallenge?: string;
  supportUrl?: string;
}

/** Escapes untrusted Markdown and configuration before adding it to a citation page. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Wraps trusted page structure in the service's small standalone HTML shell. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#17202a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f7;padding:18px;border-radius:8px}a{color:#1456a0}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Sends one completed HTML page with an explicit content type. */
function sendHtml(response: Response, html: string): void {
  response.status(200);
  response.type('html');
  response.send(html);
}

/** Creates the public HTTP server for MCP calls, citations, and submission pages. */
export function createCanaryHttpServer(options: CanaryHttpOptions): Server {
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: options.allowedHosts });
  const supportUrl = options.supportUrl ?? 'https://github.com/CTristan/obsidian-git-mcp/issues';

  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/healthz', (_request: Request, response: Response) =>
    response.status(200).json({ status: 'ok' }),
  );
  app.get('/.well-known/openai-apps-challenge', (_request: Request, response: Response) => {
    if (!options.domainChallenge) return response.status(404).type('text').send('Not configured');
    return response.status(200).type('text').send(options.domainChallenge);
  });
  app.get('/', (_request: Request, response: Response) => {
    const links = options.catalog
      .documents()
      .map((document) => `<li><a href="/notes/${encodeURIComponent(document.id)}">${escapeHtml(document.title)}</a></li>`)
      .join('');
    sendHtml(
      response,
      page(
        'obsidian-git-mcp documentation',
        `<h1>obsidian-git-mcp documentation</h1><p>This read-only service lets ChatGPT and Codex search the project's current Git-tracked documentation.</p><ul>${links}</ul>`,
      ),
    );
  });
  app.get('/notes/:id', (request: Request, response: Response) => {
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    const document = id === undefined ? undefined : options.catalog.fetch(id);
    if (document === undefined) return response.status(404).type('text').send('Document not found');
    sendHtml(
      response,
      page(document.title, `<h1>${escapeHtml(document.title)}</h1><pre>${escapeHtml(document.text)}</pre>`),
    );
  });
  app.get('/privacy', (_request: Request, response: Response) => {
    sendHtml(
      response,
      page(
        'Privacy policy',
        '<h1>Privacy policy</h1><p>This service searches a fixed public documentation corpus. It does not require an account, accept vault contents, store tool inputs, or share query data with another service.</p><p>The hosting provider may retain standard security and access logs for up to 30 days. Those logs support abuse prevention and operational troubleshooting.</p>',
      ),
    );
  });
  app.get('/terms', (_request: Request, response: Response) => {
    sendHtml(
      response,
      page(
        'Terms of use',
        '<h1>Terms of use</h1><p>This service provides read-only access to the public obsidian-git-mcp documentation. Use the cited repository as the canonical source when accuracy matters.</p><p>The service comes without a guarantee of availability. Do not use it to submit private, regulated, or confidential information because it does not need that information to answer documentation questions.</p>',
      ),
    );
  });
  app.get('/support', (_request: Request, response: Response) => {
    sendHtml(
      response,
      page(
        'Support',
        `<h1>Support</h1><p>Report a problem or ask for help through the <a href="${escapeHtml(supportUrl)}">project issue tracker</a>.</p>`,
      ),
    );
  });

  app.post('/mcp', async (request: Request, response: Response) => {
    const mcp = createCanaryMcpServer(options.catalog);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!response.headersSent) {
        response.status(500).json({
          error: { code: -32603, message: 'Internal server error' },
          id: null,
          jsonrpc: '2.0',
        });
      }
    } finally {
      await Promise.allSettled([transport.close(), mcp.close()]);
    }
  });
  app.get('/mcp', (_request: Request, response: Response) =>
    response.status(405).json({
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
      jsonrpc: '2.0',
    }),
  );
  app.delete('/mcp', (_request: Request, response: Response) =>
    response.status(405).json({
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
      jsonrpc: '2.0',
    }),
  );

  return createServer(app);
}
