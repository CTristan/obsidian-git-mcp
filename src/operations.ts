import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const PREPARED_OPERATIONS = [
  'create_note',
  'patch_note',
  'update_frontmatter',
  'manage_tags',
  'append_to_section',
] as const;

export type PreparedOperationName = (typeof PREPARED_OPERATIONS)[number];
export type VaultOperationStatus =
  | 'prepared'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'indeterminate'
  | 'stale'
  | 'expired';

export interface VaultOperationRecord {
  schemaVersion: 1;
  requestId: string;
  actor: string;
  operation: PreparedOperationName;
  arguments: Record<string, unknown>;
  baseHeadSha: string;
  digest: string;
  affectedPaths: string[];
  preview: string;
  createdAt: string;
  expiresAt: string;
  status: VaultOperationStatus;
  result?: CallToolResult;
  error?: string;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Produces stable JSON for operation fingerprints without depending on object insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Binds one request to its actor, base commit, operation, and complete normalized arguments. */
export function operationDigest(input: {
  actor: string;
  baseHeadSha: string;
  operation: PreparedOperationName;
  arguments: Record<string, unknown>;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** Persists replay state outside the vault through owner-only atomic JSON replacements. */
export class OperationStore {
  private initialized = false;

  /** Binds this store to one private directory outside the canonical vault checkout. */
  constructor(private readonly directory: string) {}

  /** Creates and tightens the state directory before the first record access. */
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('the operation state path must be a real directory');
    }
    await chmod(this.directory, 0o700);
    this.initialized = true;
  }

  /** Resolves one validated UUID to its fixed JSON record path. */
  private pathFor(requestId: string): string {
    if (!REQUEST_ID.test(requestId)) throw new Error('requestId must be a UUID');
    return join(this.directory, `${requestId}.json`);
  }

  /** Allocates and durably records a new prepared operation. */
  async create(
    record: Omit<VaultOperationRecord, 'schemaVersion' | 'requestId' | 'status'>,
  ): Promise<VaultOperationRecord> {
    const created: VaultOperationRecord = {
      ...record,
      schemaVersion: 1,
      requestId: randomUUID(),
      status: 'prepared',
    };
    await this.write(created);
    return created;
  }

  /** Reads one durable operation record, or returns undefined when it does not exist. */
  async get(requestId: string): Promise<VaultOperationRecord | undefined> {
    await this.initialize();
    let raw: string;
    try {
      raw = await readFile(this.pathFor(requestId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as VaultOperationRecord;
    if (parsed.schemaVersion !== 1 || parsed.requestId !== requestId) {
      throw new Error('the operation record is invalid');
    }
    return parsed;
  }

  /** Atomically replaces one operation record with owner-only permissions. */
  async write(record: VaultOperationRecord): Promise<void> {
    await this.initialize();
    const destination = this.pathFor(record.requestId);
    const temporary = join(this.directory, `.${record.requestId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      throw err;
    }
  }
}
