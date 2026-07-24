import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
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
  overrides: Omit<Partial<VaultServerConfig>, 'vaultPath'> = {},
): Promise<TestServer> {
  const server = await createVaultServer({
    collaborator: TEST_COLLABORATOR,
    // Zero throttle so read-freshness behavior is deterministic in tests.
    readFreshnessMs: 0,
    ...overrides,
    // vaultPath stays last so overrides can never repoint the server outside the
    // fixture sandbox — startup reconciliation hard-resets whatever it points at.
    vaultPath: fixture.serverDir,
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

/**
 * Wraps a `beforePush` callback so it fires exactly once, however many times the retry loop
 * invokes the hook — the concurrent-write simulations need the collaborator to race in on the
 * first push attempt only, not again on every bounded retry.
 */
export function onceHook(fn: () => Promise<void>): () => Promise<void> {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await fn();
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

/**
 * A refused write must leave no trace in the checkout: nothing staged or dirty, and no
 * committed-but-unpushed local commit. We count unpushed commits against origin/main rather
 * than a pre-call HEAD snapshot because the transaction fast-forwards HEAD to the remote
 * before it can reject a write, so a snapshot HEAD would differ for a reason unrelated to
 * the stray-commit bug this guards.
 */
export async function expectCleanCheckout(fx: Fixture): Promise<void> {
  expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  expect(await git(['rev-list', '--count', 'origin/main..HEAD'], fx.serverDir)).toBe('0');
}

/** Commits a symlink from the collaborator clone and pushes it to the remote. */
export async function commitSymlink(
  fx: Fixture,
  linkName: string,
  target: string,
  message: string,
): Promise<void> {
  await symlink(target, join(fx.collabDir, linkName));
  await git(['add', '-A'], fx.collabDir);
  await git(['commit', '-m', message], fx.collabDir);
  await git(['push', 'origin', 'main'], fx.collabDir);
}

/** Commits a chain of symlinks (each hop's target becomes the next hop's name) in one push. */
export async function commitSymlinkChain(
  fx: Fixture,
  links: ReadonlyArray<readonly [linkName: string, target: string]>,
  message: string,
): Promise<void> {
  for (const [linkName, target] of links) {
    await symlink(target, join(fx.collabDir, linkName));
  }
  await git(['add', '-A'], fx.collabDir);
  await git(['commit', '-m', message], fx.collabDir);
  await git(['push', 'origin', 'main'], fx.collabDir);
}
