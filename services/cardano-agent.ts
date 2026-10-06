// Offline-first payment service. The existing demo routes use durable adapters.
import {json, readJson, serve, type Handler} from './lib/http';
import {createPaymentRuntime, type RuntimeOptions} from './cardano-agents-ts/runtime';
import {object, PaymentError, textField} from './cardano-agents-ts/types';

export type {PaymentRequirement} from './cardano-agents-ts/types';
export {encodePaymentHeader} from './cardano-agents-ts/runtime';

export function start(port: number, options: RuntimeOptions = {}) {
  const runtime = createPaymentRuntime(options);
  const handle = (handler: Handler, verification = false): Handler => async (request, url) => {
    try {
      return await handler(request, url);
    } catch (error) {
      if (error instanceof PaymentError) {
        return json(verification ? {valid: false, reason: error.message} : {error: error.message}, error.status);
      }
      if (error instanceof SyntaxError) return json({error: 'invalid JSON'}, 400);
      throw error;
    }
  };
  const receiptId = async (request: Request) =>
    textField(object(await readJson<unknown>(request)).receiptId, 'receiptId');
  const server = serve('cardano-agent', port, {
    'GET /wallet': handle(async () => json(await runtime.wallet())),
    'GET /receipts': handle(() => json(runtime.receipts())),
    'GET /settlement': handle((request, url) =>
      json(runtime.settlement(textField(url.searchParams.get('receiptId'), 'receiptId')))),
    'POST /pay': handle(async (request) => json(await runtime.pay(await readJson<unknown>(request)))),
    'POST /confirm': handle(async (request) => json(await runtime.confirm(await receiptId(request)))),
    'POST /verify': handle(async (request) => json(await runtime.verify(await readJson<unknown>(request))), true),
    'POST /deliver': handle(async (request) => json(await runtime.deliver(await readJson<unknown>(request)))),
    'POST /refund': handle(async (request) => json({receipt: await runtime.refund(await receiptId(request))})),
  });
  runtime.startReconciliation();
  let stopping: Promise<void>|undefined;
  return {
    port: server.port!,
    stop(force = false) {
      stopping ??= (async () => {
        try {
          await server.stop(force);
        } finally {
          await runtime.close();
        }
      })();
      return stopping;
    },
  };
}
