import { constants } from 'node:fs';
import { readFile, readlink, realpath, rm, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
import {
  applyCloneDiff,
  changedManifestPaths,
  cloneWorktree,
  manifestOf,
  openPinnedHandle,
  writeAllAt,
} from './staging.js';
import { Transactor, type Identity } from './transaction.js';
import { refuseExecutableFrontmatter, validateNoteContent, ValidationError } from './validate.js';

// Single source of truth for the reported version: read it from package.json at load
// rather than duplicating the literal. `../package.json` resolves the same from both src/
// (tsx/vitest) and the compiled dist/ output, since each sits one directory below the root.
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

// Must mirror MCPVault's own PathFilter.allowedExtensions exactly (currently
// ['.md', '.markdown', '.txt', '.base', '.canvas']) — MCPVault's FrontmatterHandler runs
// gray-matter on every one of these on every read, and gray-matter's default js/javascript
// engines execute frontmatter code unless refuseExecutableFrontmatter runs first. A drift
// test in test/unit/server.test.ts asserts this stays a superset of MCPVault's runtime
// allowedExtensions.
export const FRONTMATTER_PARSED_EXTENSIONS = ['.md', '.markdown', '.txt', '.base', '.canvas'];

// The security-gate predicate: every extension MCPVault will hand to gray-matter, so every
// one of them must clear validateChangedFile/refuseExecutableNote below. Use this at both
// security sites, not isMarkdownNote — narrowing to markdown there would leave .txt/.base/
// .canvas notes unscanned for the ---js RCE and forwarded to MCPVault unchecked.
function isFrontmatterParsedFile(path: string): boolean {
  // MCPVault's own PathFilter lowercases before matching allowedExtensions, so this
  // check must too, or a mixed-case note (e.g. Note.MD) skips validation while MCPVault
  // still parses it.
  const lower = path.toLowerCase();
  return FRONTMATTER_PARSED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Narrower than isFrontmatterParsedFile: only the extensions append_to_section's
// heading-targeted rewrite is meaningful for. Appending "under a heading" to a .canvas
// (JSON) or .base (YAML) file isn't a coherent operation, so this tool stays markdown-only
// regardless of what MCPVault will parse frontmatter on.
const MARKDOWN_NOTE_EXTENSIONS = ['.md', '.markdown'];

function isMarkdownNote(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext));
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

/**
 * Runs one delegated write against a throwaway MCPVault bound to the clone `stage` and
 * returns its non-error result. A fresh server+client is spun per staged call while the
 * long-lived inner instance keeps serving reads, and both are closed even if one rejects —
 * but what to throw is decided AFTER the close, surfacing the first close failure only when
 * the call left no result to return (mirrors close()). Throwing from inside the finally
 * would itself discard an in-flight exception, the exact masking bug this ordering avoids.
 */
async function callStagedTool(
  stage: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const stageServer = createMcpVaultServer(stage, {
    name: 'mcpvault-stage',
    version: VERSION,
  });
  const [stageClientTransport, stageServerTransport] = InMemoryTransport.createLinkedPair();
  const stageClient = new Client({ name: 'obsidian-git-mcp-stage', version: VERSION });
  let callResult: CallToolResult | undefined;
  let callError: unknown;
  let closes: PromiseSettledResult<void>[] = [];
  try {
    await stageServer.connect(stageServerTransport);
    await stageClient.connect(stageClientTransport);
    callResult = (await stageClient.callTool({ name, arguments: args })) as CallToolResult;
  } catch (err) {
    callError = err;
  } finally {
    closes = await Promise.allSettled([stageClient.close(), stageServer.close()]);
  }
  // Prefer the real tool failure — a close rejection on top of it is noise that would
  // otherwise mask the error the caller actually needs.
  if (callError !== undefined) {
    throw callError;
  }
  const failedClose = closes.find((r) => r.status === 'rejected');
  if (failedClose && callResult === undefined) {
    throw (failedClose as PromiseRejectedResult).reason;
  }
  // Reaching here means the staged call assigned a result — a rejection would have
  // thrown callError above — so this both narrows the type and states that invariant.
  if (callResult === undefined) {
    throw new Error(`${name}: staged call resolved without a result`);
  }
  if (callResult.isError) {
    throw new InnerToolError(textOf(callResult));
  }
  return callResult;
}

// Path-like arg keys across the READ_TOOLS set: a single note path (read_note,
// get_frontmatter, list_directory) or a batch of them (read_multiple_notes,
// get_notes_info). search_notes/get_vault_stats/list_all_tags take none of these.
const READ_PATH_ARG_KEYS = ['path', 'paths'];

// Path-like arg keys across the write/delegated-write tools: a single note path
// (write_note, patch_note, append_to_section) or a move's source/destination
// (move_note, move_file). Named to match READ_PATH_ARG_KEYS above so the two
// containment loops that reference it (assertWriteDestinationsContained and
// forwardWrite's preflight) can't drift apart on which keys carry a path.
// move_file's confirmOldPath/confirmNewPath aren't listed: MCPVault rejects the call
// outright unless they're byte-identical to oldPath/newPath, so they never carry a
// destination of their own for containment to check.
const WRITE_PATH_ARG_KEYS = ['path', 'oldPath', 'newPath'];

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
// both use 40), so a symlink cycle (A -> B -> A) can't spin resolveSymlinkDestination
// forever the way a single readlink() can't be fooled by one hop.
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves where a forwarded path argument (read or write) would actually land on disk —
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
async function resolveSymlinkDestination(
  vaultPath: string,
  argPath: string,
): Promise<string | undefined> {
  let candidate = resolve(vaultPath, argPath);
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const realParent = await realpathNearestAncestor(dirname(candidate));
    const target = join(realParent, basename(candidate));
    let link: string;
    try {
      link = await readlink(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EINVAL' || code === 'ENOENT' || code === 'ENOTDIR') {
        return target; // not a symlink, or nothing there yet — final destination
      }
      throw err;
    }
    candidate = resolve(realParent, link);
  }
  return undefined;
}

/**
 * Classifies a resolved write destination against `realRoot`: the forbidden-path reason
 * when it lands inside the root, or the fixed out-of-vault refusal when it escapes.
 * Shared by every symlink-containment check in this file so the refusal wording and the
 * containment predicate can't drift between callers.
 */
function containmentReason(realRoot: string, resolved: string): string | undefined {
  return resolved === realRoot || resolved.startsWith(realRoot + sep)
    ? forbiddenPathReason(relative(realRoot, resolved))
    : 'refusing to follow a symlink outside the vault';
}

// Resolves every write-path arg to where it would actually land on disk and refuses one
// that escapes `root` or hits a restricted segment. We run it against the staged clone
// before the delegated write and against the live vault after it, so the two callers must
// stay identical — a shared helper is the only way they can't drift. `root`/`realRoot`
// parameterize which tree is being judged (the clone vs. the live vault); `swapContext`
// tails the message so the post-write caller can name the race without duplicating the loop.
async function assertWriteDestinationsContained(
  args: Record<string, unknown>,
  swapContext: string,
  root: string,
  realRoot: string,
): Promise<void> {
  for (const key of WRITE_PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const destination = await resolveSymlinkDestination(root, value);
    if (destination === undefined) {
      throw new InnerToolError(`${value}: symlink chain is too deep or cyclic${swapContext}`);
    }
    const reason = containmentReason(realRoot, destination);
    if (reason) {
      throw new InnerToolError(`${value}: ${reason}${swapContext}`);
    }
  }
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
      if (isFrontmatterParsedFile(relPath)) {
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
    refuseExecutableNote: async (relPath) => {
      if (!isFrontmatterParsedFile(relPath)) return;
      let content: string;
      try {
        content = await readFile(resolve(vaultPath, relPath), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // deleted/renamed away
        throw err;
      }
      refuseExecutableFrontmatter(relPath, content);
    },
  });
  await transactor.reconcileAtStartup();

  // Protocol proxy: MCPVault runs in-process behind an InMemoryTransport
  // pair, so the wrapper treats it as a black box and upgrades stay cheap.
  const inner = createMcpVaultServer(vaultPath, { name: 'mcpvault-inner', version: VERSION });
  const [innerClientTransport, innerServerTransport] = InMemoryTransport.createLinkedPair();
  const innerClient = new Client({ name: 'obsidian-git-mcp-proxy', version: VERSION });
  try {
    await inner.connect(innerServerTransport);
    await innerClient.connect(innerClientTransport);
  } catch (err) {
    await Promise.allSettled([innerClient.close(), inner.close()]);
    throw err;
  }

  const callInner = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> =>
    (await innerClient.callTool({ name, arguments: args })) as CallToolResult;

  // Same realpath-nearest-ancestor resolution as assertWriteDestinationsContained above,
  // run against READ_TOOLS' path args before forwarding to MCPVault. MCPVault's own
  // resolvePath() only confirms a symlink resolves INSIDE the vault, and its pathFilter
  // match is against the literal argument string — so a symlink whose target is
  // .git/config (or any other forbidden segment) passes both of MCPVault's checks and
  // readFile follows it straight through. An empty string is list_directory's documented
  // way of asking for the vault root, not an escape attempt, so it's exempt.
  const readPathReason = async (value: string): Promise<string | undefined> => {
    const lexical = forbiddenPathReason(value);
    if (lexical) return `${value}: ${lexical}`;
    const destination = await resolveSymlinkDestination(vaultPath, value);
    if (destination === undefined) {
      return `${value}: symlink chain is too deep or cyclic`;
    }
    const reason = containmentReason(realVaultPath, destination);
    return reason ? `${value}: ${reason}` : undefined;
  };

  const forbiddenReadArgReason = async (
    args: Record<string, unknown>,
  ): Promise<string | undefined> => {
    for (const key of READ_PATH_ARG_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value !== '') {
        const reason = await readPathReason(value);
        if (reason) return reason;
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item !== '') {
            const reason = await readPathReason(item);
            if (reason) return reason;
          }
        }
      }
    }
    return undefined;
  };

  const forwardWrite = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    // Preflight the path arguments before anything touches MCPVault — the path-filter
    // layer must refuse on its own, not lean on the post-mutation transaction check.
    for (const key of WRITE_PATH_ARG_KEYS) {
      const value = args[key];
      if (typeof value === 'string') {
        const reason = forbiddenPathReason(value);
        if (reason) {
          return errorResult(`${value}: ${reason}`);
        }
      }
    }
    const { sha, result } = await transactor.transact(commitMessageFor(name, args), async () => {
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
        const callResult = await callStagedTool(stage, name, args);

        const after = await manifestOf(stage);
        await transactor.refuseIgnoredPaths(changedManifestPaths(before, after));
        await applyCloneDiff(vaultPath, realVaultPath, stage, before, after);

        // Defense in depth: re-resolve the arg paths against the LIVE vault after applying,
        // catching a component swapped on the real path mid-transaction.
        await assertWriteDestinationsContained(
          args,
          ' (concurrent path swap detected)',
          vaultPath,
          realVaultPath,
        );
        return callResult;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
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
    // Constrain appends to markdown notes: this tool writes the filesystem directly
    // instead of forwarding to MCPVault, and "append under a heading" isn't a coherent
    // operation on a .canvas (JSON) or .base (YAML) file even though MCPVault would parse
    // frontmatter on either.
    if (!isMarkdownNote(path)) {
      return errorResult(
        `${path}: append_to_section only writes note files (${MARKDOWN_NOTE_EXTENSIONS.join(', ')})`,
      );
    }
    const absPath = resolve(vaultPath, path);
    if (!absPath.startsWith(vaultPath + sep)) {
      return errorResult(`${path}: path escapes the vault`);
    }
    const { sha } = await transactor.transact(`append_to_section: ${path} (${heading})`, async () => {
      // Symlink containment runs INSIDE the transaction, after fetch/fast-forward, so
      // it also covers a symlink that only just arrived from the remote. Unlike the
      // MCPVault-forwarded tools (which realpath-guard upstream), this tool touches the
      // filesystem itself — and a write through an out-of-vault symlink would be
      // invisible to git status, so neither commit nor rollback would ever cover it.
      let real: string;
      try {
        real = await realpath(absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new InnerToolError(`${path}: note not found`);
        }
        throw new InnerToolError(`${path}: cannot resolve note (${code ?? 'unknown error'})`);
      }
      const reason = containmentReason(realVaultPath, real);
      if (reason) {
        throw new InnerToolError(`${path}: ${reason}`);
      }
      await transactor.refuseIgnoredPaths([relative(realVaultPath, real).replaceAll('\\', '/')]);
      // fd-pin the write against a TOCTOU swap between this resolution and the write,
      // through the same guard applyCloneDiff's writer uses (staging.ts). We re-resolve
      // absPath rather than real, so the recheck covers absPath's whole symlink chain, not
      // just real's final segment.
      let handle: FileHandle | undefined;
      try {
        handle = await openPinnedHandle(
          real,
          absPath,
          real,
          constants.O_RDWR | constants.O_NOFOLLOW,
          (message) => new InnerToolError(`${path}: ${message}`),
        );
        const content = await handle.readFile('utf8');
        const updated = Buffer.from(appendToSection(content, heading, text));
        // truncate first, because a shrinking write would otherwise leave stale trailing
        // bytes; writeAllAt then loops past any short write that would corrupt the note.
        await handle.truncate(0);
        await writeAllAt(handle, updated);
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
    const wrapperToolNames = new Set(WRAPPER_TOOLS.map((tool) => tool.name));
    const visible = tools.filter(
      (t) =>
        !wrapperToolNames.has(t.name) &&
        (READ_TOOLS.has(t.name) ||
          WRITE_TOOLS.has(t.name) ||
          (allowDestructive && DESTRUCTIVE_TOOLS.has(t.name))),
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
        // The containment check has to run AFTER readTransaction's own freshen
        // (fetch/fast-forward) step, inside the same critical section — not before it —
        // or it judges the pre-fetch checkout while callInner below reads the
        // just-arrived one, letting a symlink pushed by another collaborator slip
        // through on the read that first observes it.
        const { headSha, result } = await transactor.readTransaction(async () => {
          const reason = await forbiddenReadArgReason(args);
          if (reason) {
            throw new InnerToolError(reason);
          }
          return await callInner(name, args);
        });
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
