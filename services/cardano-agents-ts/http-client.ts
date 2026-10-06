import type {PaymentConfig} from './config';
import {PaymentError, type ApiTransport, type CredentialResolver} from './types';

/** Shared request boundary. Constructors and module imports never contact APIs. */
export class PaymentApiClient {
  readonly simulated: boolean;

  constructor(
    private readonly config: PaymentConfig,
    private readonly baseUrl: string,
    private readonly transport?: ApiTransport,
    private readonly resolveCredential: CredentialResolver = (reference) => process.env[reference],
  ) {
    this.simulated = transport?.simulated ?? false;
  }

  async request(path: string, keyRef: string, header: string, init: RequestInit = {}): Promise<Response> {
    if (!this.transport && !this.config.allowNetwork) {
      throw new PaymentError('preprod API access is disabled; use simulated mode or an offline fixture transport', 503);
    }
    const key = this.resolveCredential(keyRef);
    if (!key) throw new PaymentError(`missing credential reference ${keyRef}`, 503);
    const headers = new Headers(init.headers);
    headers.set(header, key);
    try {
      return await (this.transport?.fetch ?? fetch)(`${this.baseUrl}${path}`, {
        ...init, headers, redirect: 'error', signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      // Never echo headers, response bodies, or credentials in errors.
      throw new PaymentError('payment API request failed; retry with the same idempotency key', 503);
    }
  }
}
