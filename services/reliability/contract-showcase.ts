/**
 * @fileoverview Seeds a store with demo contracts in different stages, so
 * the operator UI has something to show. Paper mode only: every contract
 * is SIMULATED and no chain transaction is sent.
 *
 * Each scenario runs the real engine with its own manual clock. The clock
 * starts in the past, so open deadlines land in the future relative to the
 * seed time. Nothing advances later unless someone acts or ticks.
 *
 *   CONTROL_DB_PATH=services/.data/agent.sqlite bun run contracts:showcase
 */

import {createHash} from 'node:crypto';
import {AgentStore} from '../../packages/db/src/index';
import {mediatorRulingBytes} from '../../packages/reliability/src/contract-lifecycle/engine';
import {generateEd25519, signBytes, type Ed25519KeyPair} from '../../packages/reliability/src/contract-lifecycle/signatures';
import type {MilestoneState, Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import {loadContractConfig} from './contract-config';
import {
  acceptTerms, act, complyAll, envOf, INSPECTORS, KIT_ENV, labReport, ManualClock, milestone, physicalDelivery,
  runUntil, settleTicks, type Kit,
} from './contract-kit';
import {ContractService} from './contract-service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** Fictional demo companies. */
export const SHOWCASE_PARTIES = {
  kopi: {id: 'kopi-origin', displayName: 'Kopi Origin Roasters'},
  highland: {id: 'highland-estates', displayName: 'Highland Estates Coffee'},
  northwind: {id: 'northwind-analytics', displayName: 'Northwind Analytics'},
  datacrate: {id: 'datacrate', displayName: 'DataCrate Exports'},
} as const;

type PartyKey = keyof typeof SHOWCASE_PARTIES;

interface Keys {
  parties: {[key in PartyKey]: Ed25519KeyPair};
  sellerLab: Ed25519KeyPair;
  judge: Ed25519KeyPair;
  mediator: Ed25519KeyPair;
}

const COFFEE_SPEC = sha('Green arabica. Moisture 12.5% or less. Screen 16+. Grade A, max 5 defects per 300 g.');
const DATASET = 'sku,region,price_usd\nA-100,SG,12.50\nA-101,MY,7.25\n';

function kitFor(databasePath: string, keys: Keys, start: number, buyer: PartyKey, seller: PartyKey): Kit {
  const store = AgentStore.open(databasePath);
  const clock = new ManualClock(start);
  const config = loadContractConfig(envOf([['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', keys.mediator.publicKeyHex]], KIT_ENV));
  const service = new ContractService(store, {config, clock});
  for (const key of [buyer, seller]) {
    const party = SHOWCASE_PARTIES[key];
    service.registerParty({
      entityId: party.id, displayName: party.displayName,
      publicKeyHex: keys.parties[key].publicKeyHex, cardanoAddress: `addr_test1_synthetic_${party.id}`,
    });
  }
  return {
    store, service, clock, buyerId: SHOWCASE_PARTIES[buyer].id, sellerId: SHOWCASE_PARTIES[seller].id,
    keys: {buyer: keys.parties[buyer], seller: keys.parties[seller], sellerLab: keys.sellerLab, judge: keys.judge, mediator: keys.mediator},
    close: () => store.close(),
  };
}

function whitelist(keys: Keys): Array<{id: string; publicKeyHex: string}> {
  return [
    {id: INSPECTORS.sellerLab, publicKeyHex: keys.sellerLab.publicKeyHex},
    {id: INSPECTORS.judge, publicKeyHex: keys.judge.publicKeyHex},
  ];
}

function coffeeLot(kit: Kit, keys: Keys, title: string, amountAtomic: string, quantity: number, remedy?: Remedy): {id: string; mId: string} {
  const contract = kit.service.lifecycle.createContract({
    templateId: 'physical-objective-spec',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title, amountAtomic, deliverable: {specDocumentSha256: COFFEE_SPEC, description: 'Green arabica, washed', quantity, unit: 'kg', grade: 'A', incoterm: 'FOB Belawan'}}],
    remedy,
    inspectorWhitelist: whitelist(keys),
    judgeInspectorId: INSPECTORS.judge,
  }, kit.sellerId);
  return {id: contract.id, mId: contract.milestones[0]?.id ?? ''};
}

function dataset(kit: Kit, title: string, amountAtomic: string): {id: string; mId: string} {
  const contract = kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title, amountAtomic, deliverable: {expectedSha256: sha(DATASET), fileName: 'prices.csv', mediaType: 'text/csv'}}],
  }, kit.buyerId);
  return {id: contract.id, mId: contract.milestones[0]?.id ?? ''};
}

async function deliverPhysical(kit: Kit, deal: {id: string; mId: string}): Promise<void> {
  acceptTerms(kit, deal.id);
  await runUntil(kit, deal.id, 'funded');
  act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
  await runUntil(kit, deal.id, 'in_inspection');
}

/** Raises a template 3 dispute with a lab report from the seller's lab (not the named judge) and lets Tier 2 time out. */
async function toTier3(kit: Kit, deal: {id: string; mId: string}): Promise<void> {
  await deliverPhysical(kit, deal);
  act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [
    labReport(kit, deal.id, deal.mId, 'FAIL', 'sellerLab'),
    {type: 'arrival_photo', content: 'SYNTHETIC-PHOTO: bags 4 and 9 show mould spots on arrival', mediaType: 'image/jpeg'},
    {type: 'note', content: 'Moisture measured at 15.9% on arrival. The contract says 12.5% or less.', mediaType: 'text/plain'},
  ]});
  await runUntil(kit, deal.id, 'tier_1_negotiation');
  act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
  await settleTicks(kit);
  kit.clock.set(milestone(kit, deal.id).dispute.tierDeadline ?? kit.clock.now());
  await runUntil(kit, deal.id, 'tier_3_mediation');
}

export interface ShowcaseResult {
  contracts: Array<{scenario: string; contractId: string; state: MilestoneState}>;
}

/** Seeds the showcase. Refuses to run twice on the same store. */
export async function seedShowcase(databasePath: string, now = Date.now()): Promise<ShowcaseResult> {
  const probe = AgentStore.open(databasePath);
  const seeded = probe.getContractParty(SHOWCASE_PARTIES.kopi.id) !== undefined;
  probe.close();
  if (seeded) throw new Error('this store already has the showcase parties; use a fresh database');

  const keys: Keys = {
    parties: {kopi: generateEd25519(), highland: generateEd25519(), northwind: generateEd25519(), datacrate: generateEd25519()},
    sellerLab: generateEd25519(), judge: generateEd25519(), mediator: generateEd25519(),
  };
  const result: ShowcaseResult = {contracts: []};
  const record = (scenario: string, kit: Kit, id: string) => {
    result.contracts.push({scenario, contractId: id, state: milestone(kit, id).state});
    kit.close();
  };

  // 1. A clean digital deal: delivered, accepted, released, settled.
  {
    const unlockLead = 11 * DAY; // funding 1 d + delivery 7 d + inspection 3 d in template 1
    const kit = kitFor(databasePath, keys, now - unlockLead - 2 * HOUR, 'northwind', 'datacrate');
    const deal = dataset(kit, 'Q3 regional retail price dataset', '1200000000');
    acceptTerms(kit, deal.id);
    await runUntil(kit, deal.id, 'funded');
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: [{type: 'content_file', content: DATASET, mediaType: 'text/csv'}]});
    await runUntil(kit, deal.id, 'in_inspection');
    act(kit, deal.id, kit.buyerId, 'accept', {milestoneId: deal.mId});
    await settleTicks(kit);
    kit.clock.set(milestone(kit, deal.id).deadlines?.unlockTime ?? kit.clock.now());
    await runUntil(kit, deal.id, 'settled', {maxSteps: 120});
    record('settled after acceptance', kit, deal.id);
  }

  // 2. A digital delivery in inspection: the buyer can still accept or dispute.
  {
    const kit = kitFor(databasePath, keys, now - 20 * HOUR, 'northwind', 'datacrate');
    const deal = dataset(kit, 'Competitor pricing export, October', '850000000');
    acceptTerms(kit, deal.id);
    await runUntil(kit, deal.id, 'funded');
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: [{type: 'content_file', content: DATASET, mediaType: 'text/csv'}]});
    await runUntil(kit, deal.id, 'in_inspection');
    record('in inspection', kit, deal.id);
  }

  // 3. A funded coffee lot that the seller has not shipped yet.
  {
    const kit = kitFor(databasePath, keys, now - 3 * HOUR, 'kopi', 'highland');
    const deal = coffeeLot(kit, keys, 'Lot 3: 1,200 kg green arabica, Grade A', '4000000000', 1200, {type: 'partial_release', sellerShareBps: 7000});
    acceptTerms(kit, deal.id);
    await runUntil(kit, deal.id, 'funded');
    record('funded, awaiting delivery', kit, deal.id);
  }

  // 4. A coffee lot in Tier 1: the parties can still agree an outcome.
  {
    const kit = kitFor(databasePath, keys, now - 18 * HOUR, 'kopi', 'highland');
    const deal = coffeeLot(kit, keys, 'Lot 2: 800 kg green arabica, Grade A', '2600000000', 800, {type: 'partial_release', sellerShareBps: 7000});
    await deliverPhysical(kit, deal);
    act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [
      {type: 'arrival_photo', content: 'SYNTHETIC-PHOTO: 3 of 16 bags are torn', mediaType: 'image/jpeg'},
      {type: 'note', content: 'Three bags arrived torn. We ask for the core-only outcome.', mediaType: 'text/plain'},
    ]});
    await runUntil(kit, deal.id, 'tier_1_negotiation');
    record('tier 1 negotiation', kit, deal.id);
  }

  // 5. A coffee lot waiting for the mediator. Tier 2 timed out about 10 hours ago.
  {
    const tier2 = 5 * DAY; // template 3 Tier 2 window
    const kit = kitFor(databasePath, keys, now - tier2 - 10 * HOUR, 'kopi', 'highland');
    const deal = coffeeLot(kit, keys, 'Lot 1: 1,000 kg green arabica, Grade A', '3250000000', 1000, {type: 'partial_release', sellerShareBps: 7000});
    await toTier3(kit, deal);
    record('tier 3 mediation, waiting for a ruling', kit, deal.id);
  }

  // 6. A coffee lot ruled for the buyer under partial_release, carried out, and settled.
  {
    const kit = kitFor(databasePath, keys, now - 9 * DAY, 'kopi', 'highland');
    const deal = coffeeLot(kit, keys, 'Sample lot: 500 kg green arabica, Grade A', '1500000000', 500, {type: 'partial_release', sellerShareBps: 7000});
    await toTier3(kit, deal);
    const ruling = {winner: 'buyer' as const, reason: 'The arrival photos and the moisture reading show the lot is below the agreed grade. The named inspector did not report before the Tier 2 deadline.'};
    kit.service.lifecycle.submitMediatorRuling(deal.id, deal.mId, ruling,
      signBytes(keys.mediator.privateKey, mediatorRulingBytes(deal.id, deal.mId, ruling)));
    await runUntil(kit, deal.id, 'resolved');
    complyAll(kit, deal.id);
    await runUntil(kit, deal.id, 'settled', {maxSteps: 120});
    record('ruled for the buyer, settled', kit, deal.id);
  }
  return result;
}

if (import.meta.main) {
  const path = process.env.CONTROL_DB_PATH;
  if (!path) throw new Error('set CONTROL_DB_PATH to the control API database');
  const result = await seedShowcase(path);
  for (const item of result.contracts) console.log(`${item.state.padEnd(28)} ${item.scenario}  ${item.contractId}`);
  console.log('All showcase contracts are SIMULATED (paper mode). Restart the control API to load them.');
}
