#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanaryCatalog } from './catalog.js';
import { createCanaryHttpServer } from './http.js';

/** Parses the configured listener port and refuses ambiguous numeric input. */
function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CANARY_PORT must be an integer between 1 and 65535');
  }
  return port;
}

/** Starts the read-only documentation service from environment configuration. */
export async function main(): Promise<void> {
  const port = positivePort(process.env.CANARY_PORT ?? '3000');
  const baseUrl = process.env.CANARY_BASE_URL ?? `http://127.0.0.1:${port}`;
  const hostname = new URL(baseUrl).hostname;
  const allowedHosts = (process.env.CANARY_ALLOWED_HOSTS ?? hostname)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const catalog = await createCanaryCatalog({
    baseUrl,
    root: resolve(process.env.CANARY_ROOT ?? process.cwd()),
  });
  const server = createCanaryHttpServer({
    allowedHosts,
    catalog,
    domainChallenge: process.env.OPENAI_APPS_CHALLENGE,
    supportUrl: process.env.CANARY_SUPPORT_URL,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`obsidian-git-mcp documentation MCP listening on port ${port}`);
  });

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
