#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVaultServer } from './index.js';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const vaultPath = process.argv[2] ?? fail('usage: obsidian-git-mcp <vault-checkout-path>');
const collaborator =
  process.env['OGM_COLLABORATOR'] ??
  fail('OGM_COLLABORATOR is required — it becomes the git author of every write');

const slug = collaborator.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');

const server = await createVaultServer({
  vaultPath,
  collaborator: {
    name: collaborator,
    email: process.env['OGM_COLLABORATOR_EMAIL'] ?? `${slug}@collaborators.obsidian-git-mcp.local`,
  },
  service: {
    name: process.env['OGM_SERVICE_NAME'] ?? 'obsidian-git-mcp',
    email: process.env['OGM_SERVICE_EMAIL'] ?? 'service@obsidian-git-mcp.local',
  },
  branch: process.env['OGM_BRANCH'] ?? 'main',
  remote: process.env['OGM_REMOTE'] ?? 'origin',
  allowDestructive: process.env['OGM_ALLOW_DESTRUCTIVE'] === '1',
});

await server.connect(new StdioServerTransport());
