/**
 * @fileoverview Error type for the contract lifecycle.
 * `code` is stable. Routes map it to an HTTP status.
 */

/** A rejected contract action. The message says what to fix. */
export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}
