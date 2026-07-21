import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createServer as createMcpVaultServer } from '@bitbonsai/mcpvault';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { appendToSection } from './append.js';
import { runGit } from './git.js';
import { forbiddenPathReason } from './paths.js';
import { Transactor, type Identity } from './transaction.js';
import { validateNoteContent, ValidationError } from './validate.js';

const VERSION = '0.1.0';

// MCPVault's 15 tools, classified by effect. Anything unknown is refused, because a
// future MCPVault tool we haven't classified must not silently bypass the transaction
// wrapper.
const READ_TOOLS = new Set([
  'read_note',
  'read_multiple_notes',
  'search_notes',
  'list_directory',
  'get_frontmatter',
  'get_notes_info',
  'get_vault_stats',
  'list_all_tags',
]);
const WRITE_TOOLS = new Set(['write_note', 'patch_note', 'update_frontmatter', 'manage_tags']);
const DESTRUCTIVE_TOOLS = new Set(['delete_note', 'move_note', 'move_file']);

const WRAPPER_TOOLS: Tool[] = [
  {
    name: 'vault_status',
    description:
      'Report repository state: HEAD commit, branch, dirty flag, and ahead/behind counts against the remote.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_changes',
    description: 'List recent vault commits, newest first, optionally limited to one path.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum commits to return (default 20)' },
        path: { type: 'string', description: 'Restrict history to this vault path' },
      },
    },
  },
  {
    name: 'append_to_section',
    description:
      'Append text under a named heading of a note. Creates the section at the end of the note when the heading is absent.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path' },
        heading: { type: 'string', description: 'Heading text (without the # marks)' },
        text: { type: 'string', description: 'Text to append' },
      },
      required: ['path', 'heading', 'text'],
    },
  },
];

export interface VaultServerConfig {
  /** Path to a plain git clone of the vault. Never a live Obsidian directory. */
  vaultPath: string;
  /** Recorded as the git author of every write — this is the audit trail. */
  collaborator: Identity;
  /** Recorded as the git committer. */
  service?: Identity;
  branch?: string;
  remote?: string;
  /** Expose delete_note / move_note / move_file. Off by default. */
  allowDestructive?: boolean;
  /** How stale a read may be before it fetches. Default 30s. */
  readFreshnessMs?: number;
  /** Extra push attempts after a clean push race. Default 2. */
  maxPushRetries?: number;
  /** Test seams. Not for production use. */
  testHooks?: { beforePush?: () => Promise<void> };
}

export interface VaultServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function textResult(text: string, meta?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (meta) {
    result._meta = meta;
  }
  return result;
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function commitMessageFor(tool: string, args: Record<string, unknown>): string {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  if (tool === 'move_note' || tool === 'move_file') {
    return `${tool}: ${str('oldPath')} -> ${str('newPath')}`;
  }
  return `${tool}: ${str('path') || '(multiple)'}`;
}

/** Raised when the inner MCPVault tool itself rejected the call mid-transaction. */
class InnerToolError extends Error {
  override name = 'InnerToolError';
}

export async function createVaultServer(config: VaultServerConfig): Promise<VaultServer> {
  const vaultPath = resolve(config.vaultPath);
  const branch = config.branch ?? 'main';
  const remote = config.remote ?? 'origin';
  const allowDestructive = config.allowDestructive ?? false;
  const service = config.service ?? {
    name: 'obsidian-git-mcp',
    email: 'service@obsidian-git-mcp.local',
  };

  // Fail fast when the path isn't a git checkout — everything downstream assumes one.
  await runGit(['rev-parse', '--git-dir'], vaultPath);

  const transactor = new Transactor({
    vaultPath,
    branch,
    remote,
    collaborator: config.collaborator,
    service,
    readFreshnessMs: config.readFreshnessMs ?? 30_000,
    maxPushRetries: config.maxPushRetries ?? 2,
    beforePush: config.testHooks?.beforePush,
    validateChangedFile: async (relPath) => {
      const reason = forbiddenPathReason(relPath);
      if (reason) {
        throw new ValidationError(`${relPath}: ${reason}`);
      }
      if (relPath.endsWith('.md')) {
        let content: string;
        try {
          content = await readFile(resolve(vaultPath, relPath), 'utf8');
        } catch {
          return; // deleted file — nothing to validate
        }
        validateNoteContent(relPath, content);
      }
    },
  });
  await transactor.reconcileAtStartup();

  // Option (a) protocol proxy: MCPVault runs in-process behind an InMemoryTransport
  // pair, so the wrapper treats it as a black box and upgrades stay cheap.
  const inner = createMcpVaultServer(vaultPath, { name: 'mcpvault-inner', version: VERSION });
  const [innerClientTransport, innerServerTransport] = InMemoryTransport.createLinkedPair();
  await inner.connect(innerServerTransport);
  const innerClient = new Client({ name: 'obsidian-git-mcp-proxy', version: VERSION });
  await innerClient.connect(innerClientTransport);

  const callInner = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> =>
    (await innerClient.callTool({ name, arguments: args })) as CallToolResult;

  const forwardWrite = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    let result: CallToolResult | undefined;
    const sha = await transactor.transact(commitMessageFor(name, args), async () => {
      result = await callInner(name, args);
      if (result.isError) {
        throw new InnerToolError(textOf(result));
      }
    });
    return { ...result!, _meta: { ...(result!._meta ?? {}), commitSha: sha } };
  };

  const appendTool = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const heading = typeof args['heading'] === 'string' ? args['heading'] : '';
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const reason = forbiddenPathReason(path);
    if (reason) {
      return errorResult(`${path}: ${reason}`);
    }
    const absPath = resolve(vaultPath, path);
    if (!absPath.startsWith(vaultPath + sep)) {
      return errorResult(`${path}: path escapes the vault`);
    }
    const sha = await transactor.transact(`append_to_section: ${path} (${heading})`, async () => {
      let content: string;
      try {
        content = await readFile(absPath, 'utf8');
      } catch {
        throw new InnerToolError(`${path}: note not found`);
      }
      await writeFile(absPath, appendToSection(content, heading, text));
    });
    return textResult(`Appended to "${heading}" in ${path}`, { commitSha: sha });
  };

  const outer = new Server(
    { name: 'obsidian-git-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  outer.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await innerClient.listTools();
    const visible = tools.filter((t) => allowDestructive || !DESTRUCTIVE_TOOLS.has(t.name));
    return { tools: [...visible, ...WRAPPER_TOOLS] };
  });

  outer.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'vault_status') {
        return textResult(JSON.stringify(await transactor.status(), null, 2));
      }
      if (name === 'list_recent_changes') {
        const limit = Math.min(Math.max(Number(args['limit'] ?? 20) || 20, 1), 200);
        const path = typeof args['path'] === 'string' ? args['path'] : undefined;
        return textResult(await transactor.recentChanges(limit, path));
      }
      if (name === 'append_to_section') {
        return await appendTool(args);
      }
      if (DESTRUCTIVE_TOOLS.has(name)) {
        if (!allowDestructive) {
          return errorResult(
            `${name} is disabled by default; start the server with destructive tools enabled to use it`,
          );
        }
        return await forwardWrite(name, args);
      }
      if (WRITE_TOOLS.has(name)) {
        return await forwardWrite(name, args);
      }
      if (READ_TOOLS.has(name)) {
        const headSha = await transactor.freshenForRead();
        const result = await callInner(name, args);
        return { ...result, _meta: { ...(result._meta ?? {}), headSha } };
      }
      return errorResult(`unknown tool: ${name}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  return {
    async connect(transport: Transport): Promise<void> {
      await outer.connect(transport);
    },
    async close(): Promise<void> {
      await innerClient.close();
      await inner.close();
      await outer.close();
    },
  };
}
