import {BlockFrostAPI} from '@blockfrost/blockfrost-js';
import {Readable} from 'node:stream';
import type {PaymentConfig} from './config';
import {PaymentApiClient} from './http-client';
import {PaymentError, type ApiTransport, type CredentialResolver} from './types';

/** Initializes the official SDK without resolving keys or making requests. */
export function createBlockfrostSdk(config: PaymentConfig, transport?: ApiTransport, resolver?: CredentialResolver): BlockFrostAPI {
  const client = new PaymentApiClient(config, config.blockfrostUrl, transport, resolver);
  return new BlockFrostAPI({
    network: 'preprod', customBackend: config.blockfrostUrl,
    requestTimeout: config.requestTimeoutMs, rateLimiter: false, debug: false,
    gotOptions: {
      retry: {limit: 0}, followRedirect: false,
      hooks: {beforeRequest: [async (options) => {
        // Run every SDK endpoint through the guarded transport. Returning a
        // response stream prevents got from opening a second network connection.
        const url = options.url.toString();
        const base = `${config.blockfrostUrl}/`;
        if (!url.startsWith(base)) throw new PaymentError('unexpected Blockfrost SDK endpoint', 503);
        const headers = new Headers();
        for (const [name, value] of Object.entries(options.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        if (options.body !== undefined && typeof options.body !== 'string' && !Buffer.isBuffer(options.body)) {
          throw new PaymentError('unsupported SDK request body');
        }
        const response = await client.request(`/${url.slice(base.length)}`, config.blockfrostKeyRef, 'project_id', {
          method: options.method, headers,
          body: Buffer.isBuffer(options.body) ? new Uint8Array(options.body) : options.body,
        });
        const responseHeaders = Object.fromEntries(response.headers);
        // fetch has already decompressed the body.
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        const body = Buffer.from(await response.arrayBuffer());
        return Object.assign(Readable.from([body]), {
          statusCode: response.status, headers: responseHeaders, body, url,
        });
      }]},
    },
  });
}
