#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVaultServer } from './index.js';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const vaultPath =
  process.argv[2]?.trim() || fail('usage: obsidian-git-mcp <vault-checkout-path>');
const rawCollaborator =
  process.env['OGM_COLLABORATOR']?.trim() ||
  fail('OGM_COLLABORATOR is required — it becomes the git author of every write');
const collaborator =
  rawCollaborator.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() ||
  fail('OGM_COLLABORATOR must contain a valid git author name');

// Fall back to a fixed slug when the name has no alphanumerics at all, because an
// empty local part would make the default author email malformed.
const slug =
  collaborator.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '') ||
  'collaborator';

try {
  const server = await createVaultServer({
    vaultPath,
    collaborator: {
      name: collaborator,
      email:
        process.env['OGM_COLLABORATOR_EMAIL']?.trim() ||
        `${slug}@collaborators.obsidian-git-mcp.local`,
    },
    service: {
      name: process.env['OGM_SERVICE_NAME']?.trim() || 'obsidian-git-mcp',
      email: process.env['OGM_SERVICE_EMAIL']?.trim() || 'service@obsidian-git-mcp.local',
    },
    branch: process.env['OGM_BRANCH']?.trim() || 'main',
    remote: process.env['OGM_REMOTE']?.trim() || 'origin',
    allowDestructive: process.env['OGM_ALLOW_DESTRUCTIVE'] === '1',
  });
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => {
      console.error('failed to stop obsidian-git-mcp: shutdown timed out');
      process.exit(1);
    }, 5_000);
    void server.close().then(
      () => {
        clearTimeout(timeout);
        process.exit(0);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        console.error(
          `failed to stop obsidian-git-mcp: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await server.connect(new StdioServerTransport());
  } catch (err) {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    throw err;
  }
} catch (err) {
  // Startup failures (bad vault path, unreachable remote) exit like argument errors do,
  // instead of surfacing as a raw unhandled-rejection stack trace.
  fail(`failed to start obsidian-git-mcp: ${err instanceof Error ? err.message : String(err)}`);
}
