export { appendToSection } from './append.js';
export { GitError } from './git.js';
export { forbiddenPathReason } from './paths.js';
export { createVaultServer, type VaultServer, type VaultServerConfig } from './server.js';
export {
  ConflictError,
  DirtyCheckoutError,
  HiddenIgnoredWriteError,
  IndeterminatePushError,
  LockError,
  TransactionError,
  Transactor,
  type Identity,
  type TransactorConfig,
} from './transaction.js';
export { ValidationError, validateNoteContent } from './validate.js';
