/**
 * @fileoverview Day 2 on-chain proof: one contract through the Masumi V2
 * escrow on Cardano preprod, with real test USDM.
 *
 *   bun run contracts:smoke             clean release (deliver, accept, collect)
 *   bun run contracts:smoke --dispute   wrong file, code judge, seller refunds
 *
 * It refuses to run unless CARDANO_MODE=preprod, CARDANO_ALLOW_NETWORK=true,
 * and MASUMI_PAYMENT_SOURCE_TYPE=Web3CardanoV2. Read the "Day 2 preprod
 * run" section of services/reliability/.env.contracts.example first.
 *
 * Progress is saved to services/.data/ (git-ignored), so the script resumes
 * after a stop. The saved file holds demo party keys for this test run.
 * It never prints a credential. Expect about 50 minutes for a clean
 * release: MPS deadlines need 15 minute gaps, and MPS withdraws 10 minutes
 * after unlockTime.
 */

import {createPrivateKey, createPublicKey, randomUUID, type KeyObject} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentStore} from '../../packages/db/src/index';
import {partyActionBytes, type PartyAction, type PartyActionType} from '../../packages/reliability/src/contract-lifecycle/engine';
import {sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import {generateEd25519, signBytes} from '../../packages/reliability/src/contract-lifecycle/signatures';
import type {MilestoneState} from '../../packages/reliability/src/contract-lifecycle/types';
import {PreprodCardanoAdapter} from '../cardano-agents-ts/cardano';
import {ContractService} from './contract-service';

const EXPLORER = 'https://preprod.cardanoscan.io/transaction/';
const STATE_FILE = fileURLToPath(new URL('../.data/contract-smoke.json', import.meta.url));
const DATABASE = process.env.CONTROL_DB_PATH ?? fileURLToPath(new URL('../.data/agent.sqlite', import.meta.url));
const FILE = 'TOKEN2049 contract lifecycle preprod smoke test\n';
const dispute = process.argv.includes('--dispute');
const LABEL = '[LIVE preprod]';

interface SmokeState {
  scenario: 'release'|'dispute';
  contractId: string|null;
  buyerKeyPem: string;
  sellerKeyPem: string;
}

function log(message: string): void {
  console.log(`${LABEL} ${new Date().toISOString().slice(11, 19)} ${message}`);
}

function publicHex(key: KeyObject): string {
  const jwk = createPublicKey(key).export({format: 'jwk'});
  return Buffer.from(String(jwk.x), 'base64url').toString('hex');
}

function loadState(): SmokeState {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SmokeState;
    if (saved.scenario === (dispute ? 'dispute' : 'release')) return saved;
    throw new Error(`${STATE_FILE} holds a ${saved.scenario} run; finish it or move the file`);
  }
  const pem = (key: KeyObject) => String(key.export({type: 'pkcs8', format: 'pem'}));
  const state: SmokeState = {
    scenario: dispute ? 'dispute' : 'release',
    contractId: null,
    buyerKeyPem: pem(generateEd25519().privateKey),
    sellerKeyPem: pem(generateEd25519().privateKey),
  };
  saveState(state);
  return state;
}

function saveState(state: SmokeState): void {
  mkdirSync(dirname(STATE_FILE), {recursive: true});
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), {mode: 0o600});
}

mkdirSync(dirname(DATABASE), {recursive: true});
const store = AgentStore.open(DATABASE);
const service = new ContractService(store);
if (service.mode !== 'live') {
  log('refusing to run: set CARDANO_MODE=preprod and CARDANO_ALLOW_NETWORK=true (see .env.contracts.example)');
  process.exit(1);
}
const state = loadState();
const buyerKey = createPrivateKey(state.buyerKeyPem);
const sellerKey = createPrivateKey(state.sellerKeyPem);
const buyerId = 'smoke-buyer';
const sellerId = 'smoke-seller';
const lifecycle = service.lifecycle;

function act(contractId: string, partyId: string, action: PartyActionType, milestoneId: string|null, content?: string): void {
  const request: PartyAction = {
    actionId: randomUUID(), contractId, milestoneId, partyId, action,
    evidence: content === undefined ? undefined : [{type: action === 'dispute' ? 'note' : 'content_file', content}],
  };
  lifecycle.perform(request, signBytes(partyId === buyerId ? buyerKey : sellerKey, partyActionBytes(request)));
}

async function waitFor(contractId: string, states: MilestoneState[]): Promise<MilestoneState> {
  let last = '';
  for (;;) {
    await service.tick();
    const current = lifecycle.getContract(contractId).milestones[0];
    if (!current) throw new Error('the contract has no milestone');
    const line = `${current.state}${current.pending ? ` (waiting for ${current.pending.kind})` : ''}: ` +
      current.tranches.map((tranche) => `${tranche.chain.onChainState ?? 'no escrow yet'}${tranche.chain.confirmed ? '' : ' (tx in flight)'}`).join(', ');
    if (line !== last) log(line);
    last = line;
    if (states.includes(current.state)) return current.state;
    const stuck = lifecycle.operations(contractId).filter((operation) => operation.status === 'failed');
    if (stuck.length > 0) throw new Error(`an escrow write was rejected: ${stuck.map((operation) => `${operation.kind}: ${operation.lastError}`).join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, service.config.workerIntervalMs));
  }
}

log(`custody: ${service.config.settings.custodyModel} (platform-managed preprod test wallets)`);
for (const [id, key] of [[buyerId, buyerKey], [sellerId, sellerKey]] as const) {
  const address = process.env[id === buyerId ? 'CONTRACT_SMOKE_BUYER_ADDRESS' : 'CONTRACT_SMOKE_SELLER_ADDRESS'] ?? `addr_test1_synthetic_${id}`;
  // Key registration needs a KYC-verified entity. The smoke parties are
  // platform test wallets, so the run records them as verified (mock KYC).
  if (!store.getEntity(id)) {
    store.insertEntity({
      id, displayName: id, wallets: [], roles: ['buyer', 'seller'],
      kycStatus: 'verified', kycTier: 'basic', createdAt: new Date().toISOString(),
    });
  }
  service.registerParty({entityId: id, publicKeyHex: publicHex(key), cardanoAddress: address});
}

let contractId = state.contractId;
if (!contractId) {
  const deliverable = {expectedSha256: sha256Hex(FILE), fileName: 'smoke.txt'};
  contractId = lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId,
    sellerId,
    milestones: [{title: `preprod smoke (${state.scenario})`, amountAtomic: process.env.CONTRACT_SMOKE_AMOUNT_ATOMIC ?? '1000000', deliverable}],
  }, buyerId).id;
  state.contractId = contractId;
  saveState(state);
  act(contractId, buyerId, 'submit_for_acceptance', null);
  const bytes = lifecycle.termsBytes(contractId);
  lifecycle.signTerms(contractId, buyerId, signBytes(buyerKey, bytes));
  lifecycle.signTerms(contractId, sellerId, signBytes(sellerKey, bytes));
  log(`contract ${contractId} signed by both parties; funding is journaled`);
}

const milestoneId = lifecycle.getContract(contractId).milestones[0]?.id ?? '';
let reached = await waitFor(contractId, ['funded', 'in_inspection', 'accepted_pending_release', 'resolved', 'settled', 'refunded', 'expired']);
if (reached === 'funded') {
  act(contractId, sellerId, 'deliver', milestoneId, dispute ? 'the wrong file' : FILE);
  log('seller delivered; result hash journaled');
  reached = await waitFor(contractId, ['in_inspection']);
}
if (reached === 'in_inspection') {
  if (dispute) act(contractId, buyerId, 'dispute', milestoneId, 'the delivered file does not match the agreed hash');
  else act(contractId, buyerId, 'accept', milestoneId);
  log(dispute ? 'buyer disputed; the code judge rules when the dispute confirms' : 'buyer accepted (off-chain); the escrow releases at unlockTime');
  reached = await waitFor(contractId, dispute ? ['resolved'] : ['settled']);
}
if (reached === 'resolved') {
  const current = lifecycle.getContract(contractId).milestones[0]!;
  for (const obligation of current.dispute.obligations) {
    if (obligation.compliedAt === null && obligation.forcedAt === null) {
      act(contractId, obligation.party === 'buyer' ? buyerId : sellerId, 'comply_with_ruling', milestoneId);
      log(`the ${obligation.party} carried out the ruling (${obligation.action})`);
    }
  }
  await waitFor(contractId, ['settled']);
}

const final = lifecycle.getContract(contractId).milestones[0]!;
log(`final state ${final.state}, outcome ${final.outcome}`);
const cardano = new PreprodCardanoAdapter(service.config.payment);
for (const tranche of final.tranches) {
  log(`escrow ${tranche.escrowRef}`);
  for (const hash of [tranche.chain.settlementTxHash, tranche.chain.lastTxHash]) {
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) continue;
    log(`  tx ${hash}: ${EXPLORER}${hash}`);
    try {
      const evidence = await cardano.observeSettlementTransaction(hash);
      log(`  Blockfrost: indexed ${evidence.indexed}, valid script ${evidence.validContract}, confirmations ${evidence.confirmations}, block time ${evidence.blockTime ?? 'n/a'}`);
    } catch (error) {
      log(`  Blockfrost check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
const record = store.getOutcome(`${contractId}/m0`)?.evidence as {collectionTxHash?: string|null}|undefined;
log(`collection tx for the submission: ${record?.collectionTxHash ?? 'none (refund scenario or not confirmed yet)'}`);
log('the seller payout landed on the platform selling wallet (custodial test setup); measure the net test USDM there');
store.close();
