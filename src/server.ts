import { constants } from 'node:fs';
import { open, readFile, readlink, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
import { forbiddenPathReason } from './paths.js';
import { applyCloneDiff, cloneWorktree, manifestOf } from './staging.js';
import { Transactor, type Identity } from './transaction.js';
import { validateNoteContent, ValidationError } from './validate.js';

const VERSION = '0.1.0';

// Every extension MCPVault's own PathFilter treats as a writable note (see its
// allowedExtensions), so a file this wrapper must validate matches exactly what MCPVault
// will actually let through — not just the shorter/common one.
const NOTE_EXTENSIONS = ['.md', '.markdown'];

function isNoteFile(path: string): boolean {
  return NOTE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

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
        limit: { type: 'integer', description: 'Maximum commits to return (default 20)' },
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

/**
 * Extracts a string tool arg, falling back when it's absent or the wrong type. Omit
 * `fallback` for the default `''`; pass `undefined` explicitly (a real third argument,
 * not a default-parameter substitution) when the caller needs to distinguish "arg
 * absent" from "arg present but empty" downstream.
 */
function stringArg(args: Record<string, unknown>, key: string): string;
function stringArg(args: Record<string, unknown>, key: string, fallback: string): string;
function stringArg(args: Record<string, unknown>, key: string, fallback: undefined): string | undefined;
function stringArg(
  args: Record<string, unknown>,
  key: string,
  ...fallback: [] | [string | undefined]
): string | undefined {
  const value = args[key];
  if (typeof value === 'string') return value;
  return fallback.length > 0 ? fallback[0] : '';
}

function commitMessageFor(tool: string, args: Record<string, unknown>): string {
  if (tool === 'move_note' || tool === 'move_file') {
    return `${tool}: ${stringArg(args, 'oldPath')} -> ${stringArg(args, 'newPath')}`;
  }
  return `${tool}: ${stringArg(args, 'path') || '(multiple)'}`;
}

/** Raised when the inner MCPVault tool itself rejected the call mid-transaction. */
class InnerToolError extends Error {
  override name = 'InnerToolError';
}

// Path-like arg keys across the READ_TOOLS set: a single note path (read_note,
// get_frontmatter, list_directory) or a batch of them (read_multiple_notes,
// get_notes_info). search_notes/get_vault_stats/list_all_tags take none of these.
const READ_PATH_ARG_KEYS = ['path', 'paths'];

/**
 * Preflights read-tool path args against forbiddenPathReason before forwarding to
 * MCPVault — mirroring forwardWrite's preflight, because MCPVault's own PathFilter is
 * not a boundary this wrapper controls. An empty string is list_directory's documented
 * way of asking for the vault root, not an escape attempt, so it's exempt.
 */
function forbiddenReadArgReason(args: Record<string, unknown>): string | undefined {
  for (const key of READ_PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') {
      const reason = forbiddenPathReason(value);
      if (reason) return `${value}: ${reason}`;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item !== '') {
          const reason = forbiddenPathReason(item);
          if (reason) return `${item}: ${reason}`;
        }
      }
    }
  }
  return undefined;
}

/**
 * realpath()'s nearest existing ancestor of `dir`, then relexically rejoins the
 * still-missing trailing segments. Plain `realpath()` requires every component to
 * exist, but a brand-new note's parent directory (or a move's destination directory)
 * routinely doesn't yet — this still resolves any symlink in the part of the path that
 * *does* exist (including the vault root itself, which may sit behind one, e.g. /tmp on
 * macOS).
 */
async function realpathNearestAncestor(dir: string): Promise<string> {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    try {
      return join(await realpath(cur), ...missing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err;
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

// Bounds symlink-chain following at roughly the OS's own SYMLOOP_MAX (Linux and macOS
// both use 40), so a symlink cycle (A -> B -> A) can't spin resolveWriteDestination
// forever the way a single readlink() can't be fooled by one hop.
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves where a forwarded write tool's path argument would actually land on disk —
 * without requiring the final target to exist, and following the FULL symlink chain
 * rather than stopping after one hop. `realpath()` throws ENOENT on a dangling symlink,
 * so a preflight built on it alone misses the reachable attack: a symlink inside the
 * vault pointing at a not-yet-existing external path, which write_note then creates. A
 * single readlink() closes that but not its chained form — a first hop that still lands
 * in-vault, where that path is itself a symlink pointing outside (or into .git) — so
 * each resolved candidate is re-checked for its own symlink-ness until one isn't.
 * Returns undefined when the chain doesn't bottom out within MAX_SYMLINK_HOPS: a real
 * cycle, or a chain deeper than any legitimate vault content needs.
 */
async function resolveWriteDestination(
  vaultPath: string,
  argPath: string,
): Promise<string | undefined> {
  let candidate = resolve(vaultPath, argPath);
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
    const realParent = await realpathNearestAncestor(dirname(candidate));
    const target = join(realParent, basename(candidate));
    let link: string;
    try {
      link = await readlink(target);
    } catch {
      return target; // not a symlink, or nothing there yet — final destination
    }
    candidate = resolve(realParent, link);
  }
  return undefined;
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
  await Transactor.assertCheckout(vaultPath);
  // Canonical vault root for symlink-containment checks (the configured path itself may
  // sit behind a symlink, e.g. /tmp on macOS).
  const realVaultPath = await realpath(vaultPath);

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
      if (isNoteFile(relPath)) {
        let content: string;
        try {
          content = await readFile(resolve(vaultPath, relPath), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // deleted file
          throw err;
        }
        validateNoteContent(relPath, content);
      }
    },
  });
  await transactor.reconcileAtStartup();

  // Protocol proxy: MCPVault runs in-process behind an InMemoryTransport
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

  // Resolves every write-path arg to where it would actually land on disk and refuses one
  // that escapes `root` or hits a restricted segment. We run it against the staged clone
  // before the delegated write and against the live vault after it, so the two callers must
  // stay identical — a shared helper is the only way they can't drift. `root`/`realRoot`
  // parameterize which tree is being judged (the clone vs. the live vault); `swapContext`
  // tails the message so the post-write caller can name the race without duplicating the loop.
  const assertWriteDestinationsContained = async (
    args: Record<string, unknown>,
    swapContext: string,
    root: string,
    realRoot: string,
  ): Promise<void> => {
    for (const key of ['path', 'oldPath', 'newPath']) {
      const value = args[key];
      if (typeof value !== 'string') continue;
      const destination = await resolveWriteDestination(root, value);
      if (destination === undefined) {
        throw new InnerToolError(`${value}: symlink chain is too deep or cyclic${swapContext}`);
      }
      const withinVault = destination.startsWith(realRoot + sep);
      const reason = withinVault
        ? forbiddenPathReason(relative(realRoot, destination))
        : 'refusing to follow a symlink outside the vault';
      if (reason) {
        throw new InnerToolError(`${value}: ${reason}${swapContext}`);
      }
    }
  };

  const forwardWrite = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    // Preflight the path arguments before anything touches MCPVault — the path-filter
    // layer must refuse on its own, not lean on the post-mutation transaction check.
    for (const key of ['path', 'oldPath', 'newPath']) {
      const value = args[key];
      if (typeof value === 'string') {
        const reason = forbiddenPathReason(value);
        if (reason) {
          return errorResult(`${value}: ${reason}`);
        }
      }
    }
    let result: CallToolResult | undefined;
    const sha = await transactor.transact(commitMessageFor(name, args), async () => {
      // Delegated writes never touch the live vault directly. We clone the fast-forwarded
      // worktree into an ephemeral 0700 dir, run a throwaway MCPVault against the clone,
      // then copy only the changed bytes back through fd-pinned writes. This narrows the
      // delegated-write race from the long-lived vault path down to a stage dir an attacker
      // must both find and tamper within this transaction's lifetime: a remote-planted
      // symlink is raceless and stays refused against the clone below; the only real-vault
      // mutations flow through applyCloneDiff's fd-pinned writes; and a same-uid live
      // attacker racing the stage dir remains theoretically possible, because nothing
      // userland stops a same-uid attacker. In-vault symlink semantics are unchanged — the
      // clone preserves links verbatim, so a delegated write through one resolves onto its
      // target exactly as before.
      const stage = await cloneWorktree(vaultPath);
      try {
        const realStage = await realpath(stage);
        // Refuse an escaping symlink against the CLONE — same resolution as the live vault,
        // minus the live-swap exposure on the long-lived path. Runs after fetch/fast-forward,
        // so it also covers a symlink that only just arrived from the remote.
        await assertWriteDestinationsContained(args, '', stage, realStage);

        const before = await manifestOf(stage);
        // Fresh throwaway MCPVault bound to the clone; the long-lived inner instance keeps
        // serving reads. Close client+server even if one rejects, surfacing the first
        // failure — but only when the call left no result to return (mirrors close()).
        const stageServer = createMcpVaultServer(stage, {
          name: 'mcpvault-stage',
          version: VERSION,
        });
        const [stageClientTransport, stageServerTransport] = InMemoryTransport.createLinkedPair();
        await stageServer.connect(stageServerTransport);
        const stageClient = new Client({ name: 'obsidian-git-mcp-stage', version: VERSION });
        await stageClient.connect(stageClientTransport);
        try {
          result = (await stageClient.callTool({ name, arguments: args })) as CallToolResult;
        } finally {
          const closes = await Promise.allSettled([stageClient.close(), stageServer.close()]);
          const failed = closes.find((r) => r.status === 'rejected');
          if (failed && result === undefined) {
            throw (failed as PromiseRejectedResult).reason;
          }
        }
        if (result.isError) {
          throw new InnerToolError(textOf(result));
        }

        const after = await manifestOf(stage);
        await applyCloneDiff(vaultPath, realVaultPath, stage, before, after);

        // Defense in depth: re-resolve the arg paths against the LIVE vault after applying,
        // catching a component swapped on the real path mid-transaction.
        await assertWriteDestinationsContained(
          args,
          ' (concurrent path swap detected)',
          vaultPath,
          realVaultPath,
        );
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
    if (!result) {
      throw new Error(`${name}: transact() resolved without running mutate`);
    }
    return { ...result, _meta: { ...(result._meta ?? {}), commitSha: sha } };
  };

  const appendTool = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const path = stringArg(args, 'path');
    const heading = stringArg(args, 'heading');
    const text = stringArg(args, 'text');
    // The schema marks all three required, but clients that skip schema validation
    // would otherwise write a stray "## " section or an empty append commit.
    if (!path || !heading.trim() || !text) {
      return errorResult('path, heading, and text are all required and must be non-empty');
    }
    const reason = forbiddenPathReason(path);
    if (reason) {
      return errorResult(`${path}: ${reason}`);
    }
    // Constrain appends to note files, because this tool writes the filesystem directly
    // instead of forwarding to MCPVault — so nothing else applies MCPVault's own
    // NOTE_EXTENSIONS filter, and validateNoteContent only runs for note files. Without
    // this an append would write unvalidated content to any non-note file (a .canvas, an
    // image, .gitattributes).
    if (!isNoteFile(path)) {
      return errorResult(
        `${path}: append_to_section only writes note files (${NOTE_EXTENSIONS.join(', ')})`,
      );
    }
    const absPath = resolve(vaultPath, path);
    if (!absPath.startsWith(vaultPath + sep)) {
      return errorResult(`${path}: path escapes the vault`);
    }
    const sha = await transactor.transact(`append_to_section: ${path} (${heading})`, async () => {
      // Symlink containment runs INSIDE the transaction, after fetch/fast-forward, so
      // it also covers a symlink that only just arrived from the remote. Unlike the
      // MCPVault-forwarded tools (which realpath-guard upstream), this tool touches the
      // filesystem itself — and a write through an out-of-vault symlink would be
      // invisible to git status, so neither commit nor rollback would ever cover it.
      let real: string;
      try {
        real = await realpath(absPath);
      } catch {
        throw new InnerToolError(`${path}: note not found`);
      }
      const reason = real.startsWith(realVaultPath + sep)
        ? forbiddenPathReason(relative(realVaultPath, real))
        : 'refusing to follow a symlink outside the vault';
      if (reason) {
        throw new InnerToolError(`${path}: ${reason}`);
      }
      // fd-pin the write against a TOCTOU swap between this resolution and the write. We
      // open the resolved target with O_NOFOLLOW (its final hop can't be turned into a
      // symlink under us), then re-resolve absPath and match the handle's inode against
      // the path's before trusting it. Soundness: a swap BEFORE open is caught here — the
      // path no longer maps to the pinned inode or it now escapes the vault; a swap AFTER
      // open can't redirect anything, because the fd is already bound to the validated
      // inode, not to a name the attacker can re-point.
      let handle: FileHandle | undefined;
      try {
        handle = await open(real, constants.O_RDWR | constants.O_NOFOLLOW);
        const reReal = await realpath(absPath);
        const reReason = reReal.startsWith(realVaultPath + sep)
          ? forbiddenPathReason(relative(realVaultPath, reReal))
          : 'refusing to follow a symlink outside the vault';
        if (reReal !== real || reReason) {
          throw new InnerToolError(`${path}: path changed during the write`);
        }
        const [handleStat, pathStat] = await Promise.all([handle.stat(), stat(real)]);
        if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
          throw new InnerToolError(`${path}: path changed during the write`);
        }
        const content = await handle.readFile('utf8');
        const updated = Buffer.from(appendToSection(content, heading, text));
        // truncate first, because FileHandle.writeFile does NOT — a shrinking write would
        // otherwise leave stale trailing bytes and corrupt the note.
        await handle.truncate(0);
        await handle.write(updated, 0, updated.length, 0);
      } finally {
        await handle?.close();
      }
    });
    return textResult(`Appended to "${heading}" in ${path}`, { commitSha: sha });
  };

  const outer = new Server(
    { name: 'obsidian-git-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  outer.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await innerClient.listTools();
    // Only classified tools are listed, so discovery always matches what's callable —
    // an unclassified tool from a future MCPVault upgrade stays hidden instead of being
    // listed and then refused on every call.
    const visible = tools.filter(
      (t) =>
        READ_TOOLS.has(t.name) ||
        WRITE_TOOLS.has(t.name) ||
        (allowDestructive && DESTRUCTIVE_TOOLS.has(t.name)),
    );
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
        const rawLimit = Number(args['limit'] ?? 20);
        const limit = Math.trunc(
          Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 200),
        );
        const path = stringArg(args, 'path', undefined);
        if (path !== undefined) {
          const reason = forbiddenPathReason(path);
          if (reason) {
            return errorResult(`${path}: ${reason}`);
          }
        }
        return textResult(await transactor.recentChanges(limit, path));
      }
      if (name === 'append_to_section') {
        return await appendTool(args);
      }
      if (DESTRUCTIVE_TOOLS.has(name)) {
        if (!allowDestructive) {
          return errorResult(
            `${name} is disabled by default; restart the server with OGM_ALLOW_DESTRUCTIVE=1 to enable it`,
          );
        }
        return await forwardWrite(name, args);
      }
      if (WRITE_TOOLS.has(name)) {
        return await forwardWrite(name, args);
      }
      if (READ_TOOLS.has(name)) {
        const reason = forbiddenReadArgReason(args);
        if (reason) {
          return errorResult(reason);
        }
        const { headSha, result } = await transactor.readTransaction(() => callInner(name, args));
        return { ...result, _meta: { ...(result._meta ?? {}), headSha } };
      }
      return errorResult(`unknown tool: ${name}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  return {
    async connect(transport: Transport): Promise<void> {
      await outer.connect(transport);
    },
    async close(): Promise<void> {
      // Close everything even when one close rejects, then surface the first failure —
      // otherwise an early rejection leaks the remaining server/transport.
      const results = await Promise.allSettled([innerClient.close(), inner.close(), outer.close()]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) {
        throw (failed as PromiseRejectedResult).reason;
      }
    },
  };
}
