/**
 * @fileoverview Paper demo of the contract lifecycle. No chain, no funds.
 *
 *   bun run contracts:demo
 *
 * 1. Template 1: a digital file, the hash matches, the buyer stays silent,
 *    and the escrow auto-releases after the 72 h window.
 * 2. Template 3: physical goods. The buyer's lab report, signed by the named
 *    inspector, contradicts the seller certificate. Tier 2 rules. The buyer
 *    and the seller carry out the partial release.
 * Time is fast-forwarded with a manual clock. Every record is labelled paper.
 */

import {createHash} from 'node:crypto';
import {
  acceptTerms, act, complyAll, createKit, INSPECTORS, inspectorWhitelist, labReport, milestone,
  physicalDelivery, runUntil, type Kit,
} from './contract-kit';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FILE = 'sku,price_usd\nA-100,12.50\nA-101,"7,25"\n';
const LABEL = '[PAPER]';

function say(kit: Kit, scenario: string, message: string): void {
  console.log(`${LABEL} ${new Date(kit.clock.now()).toISOString().slice(0, 19)} ${scenario} | ${message}`);
}

async function digitalAutoRelease(kit: Kit): Promise<string> {
  const contract = kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title: 'Price dataset', amountAtomic: '25000000', deliverable: {expectedSha256: sha(FILE), fileName: 'prices.csv'}}],
  }, kit.buyerId);
  say(kit, 'T1 digital ', `contract ${contract.id}: 25 test USDM, inspection window 72 h`);
  acceptTerms(kit, contract.id);
  await runUntil(kit, contract.id, 'funded');
  say(kit, 'T1 digital ', 'both parties signed; escrow funded (lock confirmed)');
  act(kit, contract.id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, contract.id).id, evidence: [{type: 'content_file', content: FILE}]});
  await runUntil(kit, contract.id, 'in_inspection');
  const current = milestone(kit, contract.id);
  say(kit, 'T1 digital ', `result hash confirmed; inspection open until ${new Date(current.inspectionCutoffAt!).toISOString()}`);
  kit.clock.set(current.inspectionCutoffAt!);
  await kit.service.tick();
  say(kit, 'T1 digital ', 'the buyer stayed silent: auto_released (money moves at unlockTime)');
  kit.clock.set(current.deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
  await runUntil(kit, contract.id, 'settled');
  say(kit, 'T1 digital ', 'seller withdrawal confirmed: settled');
  return contract.id;
}

async function physicalDispute(kit: Kit): Promise<string> {
  const contract = kit.service.lifecycle.createContract({
    templateId: 'physical-objective-spec',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{
      title: '20 bags green arabica, Grade A',
      amountAtomic: '10000000',
      deliverable: {specDocumentSha256: sha('arabica, moisture 12.5% or less, Grade A'), description: 'Green arabica', quantity: 1200, unit: 'kg', grade: 'A'},
    }],
    inspectorWhitelist: inspectorWhitelist(kit),
    judgeInspectorId: INSPECTORS.judge,
  }, kit.sellerId);
  const id = contract.id;
  acceptTerms(kit, id);
  await runUntil(kit, id, 'funded');
  const mId = milestone(kit, id).id;
  const [core, holdback] = milestone(kit, id).tranches;
  say(kit, 'T3 physical', `contract ${id}: 10 test USDM in two escrows (core ${core?.amountAtomic}, holdback ${holdback?.amountAtomic})`);
  act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: physicalDelivery(kit, id, mId)});
  await runUntil(kit, id, 'in_inspection');
  kit.clock.advance(30 * 3_600_000);
  act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [labReport(kit, id, mId, 'FAIL')]});
  await runUntil(kit, id, 'tier_1_negotiation');
  say(kit, 'T3 physical', 'the buyer disputed with a FAIL lab report signed by the named inspector; Tier 1 open');
  act(kit, id, kit.sellerId, 'escalate', {milestoneId: mId});
  await runUntil(kit, id, 'resolved');
  const ruling = milestone(kit, id).dispute.ruling!;
  say(kit, 'T3 physical', `Tier 2 ruling by ${ruling.decidedBy}: winner ${ruling.winner}; remedy partial_release`);
  for (const obligation of milestone(kit, id).dispute.obligations) {
    say(kit, 'T3 physical', `  obligation: the ${obligation.party} must ${obligation.action} by ${new Date(obligation.dueAt).toISOString()}`);
  }
  complyAll(kit, id);
  await runUntil(kit, id, 'settled');
  say(kit, 'T3 physical', 'core released to the seller, holdback refunded to the buyer: settled');
  return id;
}

const kit = createKit();
console.log('='.repeat(100));
console.log(`${LABEL} Paper run: no Cardano transaction is sent and no funds move.`);
console.log(`${LABEL} Custody: platform-managed test wallets (platform_custodial_test_only).`);
console.log(`${LABEL} The platform signs a ruling's payout only on the obligated party's instruction, or after the party ignores it.`);
console.log('='.repeat(100));
const ids = [await digitalAutoRelease(kit), await physicalDispute(kit)];
for (const id of ids) {
  const outcome = kit.store.getOutcome(`${id}/m0`);
  const record = outcome?.evidence as {outcome: string; releasedToSellerAtomic: string; refundedToBuyerAtomic: string; mode: string}|undefined;
  console.log(`${LABEL} reliability outcome for ${id}/m0: ${outcome?.state} (fault ${outcome?.fault ?? 'none'}, confidence ${outcome?.verificationConfidence}), ` +
    `${record?.outcome}, seller ${record?.releasedToSellerAtomic}, buyer ${record?.refundedToBuyerAtomic}, mode ${record?.mode}`);
}
console.log(`${LABEL} audit hash chain intact: ${kit.store.verifyContractAuditChain() === null}`);
kit.close();
