import {
  ConsensusAggregationByFields, consensusIdenticalAggregation, decodeJson, handler, HTTPClient, HTTPCapability,
  median, Runner, type HTTPPayload, type HTTPSendRequester, type Runtime,
} from '@chainlink/cre-sdk';
import {
  parsePaymentClaim, parseRecipientAmounts, parseTip, parseTransaction, paymentReport,
  type PaymentClaim,
} from '../../packages/evidence/src/payment';

const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
type Config = Record<string, never>;

function read(sender: HTTPSendRequester, path: string, key: string): unknown|null {
  const response = sender.sendRequest({
    url: `${BLOCKFROST_URL}${path}`, method: 'GET',
    multiHeaders: {project_id: {values: [key]}},
  }).result();
  if (response.statusCode === 404 && path.startsWith('/txs/')) return null;
  if (response.statusCode !== 200) throw new Error(`Evidence provider unavailable (${response.statusCode}).`);
  return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
}

function transaction(sender: HTTPSendRequester, claim: PaymentClaim, key: string) {
  const response = read(sender, `/txs/${claim.txHash}`, key);
  // Identical aggregation needs an object. A top-level null cannot be aggregated.
  return response === null ? {found: false, txHash: claim.txHash, validContract: false, blockHash: '', blockHeight: 0, blockTime: 0} : {found: true, ...parseTransaction(response, claim.txHash)};
}

function recipientAmounts(sender: HTTPSendRequester, claim: PaymentClaim, key: string) {
  return parseRecipientAmounts(read(sender, `/txs/${claim.txHash}/utxos`, key), claim);
}

function tip(sender: HTTPSendRequester, key: string) {
  return {height: parseTip(read(sender, '/blocks/latest', key))};
}

function checkPayment(runtime: Runtime<Config>, payload: HTTPPayload): string {
  const claim = parsePaymentClaim(decodeJson(payload.input));
  const key = runtime.getSecret({id: 'BLOCKFROST_PREPROD'}).result().value;
  const http = new HTTPClient();
  const tx = http.sendRequest(runtime, transaction, consensusIdenticalAggregation<ReturnType<typeof transaction>>())(claim, key).result();
  const observation = !tx.found ? null : {
    txHash: tx.txHash, validContract: tx.validContract, blockHash: tx.blockHash,
    blockHeight: tx.blockHeight, blockTime: tx.blockTime,
    ...http.sendRequest(runtime, recipientAmounts, consensusIdenticalAggregation<ReturnType<typeof recipientAmounts>>())(claim, key).result(),
    observedHeight: http.sendRequest(runtime, tip, ConsensusAggregationByFields<{height: number}>({height: median<number>}))(key).result().height,
  };
  const report = paymentReport(claim, observation);
  // This marker carries only the result. The API discards all other CLI output.
  const encoded = JSON.stringify(report);
  runtime.log(`TALLY_EVIDENCE_REPORT:${encoded}`);
  return encoded;
}

function initWorkflow() {
  // Empty authorization is valid only in simulation. Do not deploy this target.
  return [handler(new HTTPCapability().trigger({}), checkPayment)];
}

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
