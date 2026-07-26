import { describe, expect, it } from 'vitest';

import * as publicApi from '../../src/index.js';
import type { Identity, VaultServerConfig } from '../../src/index.js';
// @ts-expect-error `Transactor` is intentionally absent from the supported package surface.
import type { Transactor as PublicTransactor } from '../../src/index.js';
// @ts-expect-error `TransactorConfig` is intentionally absent from the supported package surface.
import type { TransactorConfig as PublicTransactorConfig } from '../../src/index.js';

describe('public package surface', () => {
  it('keeps transaction internals private while retaining supported exports', () => {
    const identity: Identity = {
      name: 'Test Collaborator',
      email: 'collaborator@test.local',
    };
    const config = {
      vaultPath: '/tmp/vault',
      collaborator: identity,
    } satisfies VaultServerConfig;

    expect(config.collaborator).toBe(identity);
    expect(publicApi).not.toHaveProperty('Transactor');
    expect(publicApi.createVaultServer).toBeTypeOf('function');
    expect(publicApi.TransactionError).toBeTypeOf('function');
    expect(publicApi.ConflictError).toBeTypeOf('function');
    expect(publicApi.DirtyCheckoutError).toBeTypeOf('function');
    expect(publicApi.HiddenIgnoredWriteError).toBeTypeOf('function');
    expect(publicApi.IndeterminatePushError).toBeTypeOf('function');
    expect(publicApi.LockError).toBeTypeOf('function');
  });
});

void (undefined as unknown as PublicTransactor);
void (undefined as unknown as PublicTransactorConfig);
