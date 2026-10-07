/**
 * @fileoverview How a Coworker writes its answer on Sokosumi. Sokosumi shows
 * the Task comment as Markdown. A buyer reads it, so engine names become plain
 * words, the short version comes first, and the technical details come last.
 *
 * The no-model answers are built here. A model gets the same plain words in
 * its system prompt (plainWordsForPrompt), so both paths read alike.
 */

import type {DraftResult, Money, RulingOption} from './coworker-tools';

/** Plain words for the engine names a reader can meet in an answer. */
export const PLAIN_WORDS: {readonly [name: string]: string} = {
  // Templates
  'physical-objective-spec': 'physical goods checked against a written spec',
  'digital-machine-checkable': 'a digital file checked against its agreed fingerprint',
  // Remedies
  partial_release: 'partial release: the seller keeps an agreed share and the buyer gets the rest back',
  full_refund_with_return: 'full refund after the goods are returned',
  full_refund_no_return: 'full refund, and the buyer keeps the goods',
  redo_or_replace: 'one redo or replacement, then a refund',
  // Outcomes the parties can agree in step 1
  full_release: 'pay the seller in full',
  core_only: 'the seller keeps the core and the buyer gets the holdback back',
  full_refund: 'refund the buyer in full',
  // Follow-ups when the buyer wins
  return_before_refund: 'the goods go back before the refund',
  one_redo_before_refund: 'the seller gets one redo before the refund',
  // Evidence
  inspection_certificate: 'inspection certificate',
  dispatch_photo: 'dispatch photo',
  seal_id: 'seal number',
  lab_report: 'lab report',
  arrival_photo: 'arrival photo',
  note: 'written note',
  // Milestone states
  draft: 'draft',
  pending_acceptance: 'waiting for both parties to sign',
  awaiting_funding: 'waiting for the buyer to fund the escrow',
  funded: 'funded, waiting for delivery',
  delivered: 'delivered',
  in_inspection: 'the buyer is inspecting the delivery',
  accepted_pending_release: 'accepted, payment being released',
  auto_released: 'paid out automatically',
  disputed: 'disputed',
  tier_1_negotiation: 'dispute step 1: the parties negotiate',
  tier_2_evidence_rule: 'dispute step 2: the agreed evidence decides',
  tier_3_mediation: 'dispute step 3: a human mediator decides',
  return_pending: 'waiting for the goods to be returned',
  redo_pending: 'waiting for the seller\'s redo',
  redo_inspection: 'the buyer is inspecting the redo',
  resolved: 'dispute resolved',
  settled: 'settled',
  cancelled: 'cancelled',
  expired: 'expired',
  refunded: 'refunded',
  // Fees and obligations
  whitelisted: 'approved (named in the contract as an inspector)',
  loser_pays: 'the side that loses pays',
  authorize_refund: 'authorize the refund',
  authorize_withdrawal: 'authorize the payout',
};

/** Fields a draft still needs before signing. */
const PLAIN_FIELDS: {readonly [field: string]: string} = {
  specDocumentSha256: 'the fingerprint (SHA-256) of the spec document',
  fileSha256: 'the fingerprint (SHA-256) of the file to deliver',
  inspectors: 'the inspectors and their public keys',
  buyerId: 'the buyer\'s Tally id',
  sellerId: 'the seller\'s Tally id',
};

export function plain(name: string|null|undefined): string {
  if (!name) return '';
  return PLAIN_WORDS[name] ?? name.replaceAll('_', ' ');
}

/** The short form of a remedy or an outcome, before the colon. */
const short = (name: string) => plain(name).split(':')[0] as string;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "inspection_certificate: at least 1, signed by a whitelisted inspector" → plain words, capitalized. */
function plainRule(rule: string): string {
  const text = rule.replace(/^([a-z_]+):/, (whole, type: string) => `${plain(type)}:`).replaceAll('a whitelisted', 'an approved').replaceAll('whitelisted', 'approved');
  return capital(text);
}

/** A judge description from the engine as one plain sentence. */
export function plainJudge(judge: string): string {
  const report = /^signed report: an? ([a-z_]+) signed by/.exec(judge);
  if (report) return `the named inspector's signed ${plain(report[1])}. Pass: the seller wins. Fail: the buyer wins.`;
  if (judge.startsWith('code:')) return 'Tally\'s code: the delivered file must match the agreed fingerprint (SHA-256).';
  return plain(judge);
}

/** A remedy description from the engine ("partial_release (seller keeps …)") in plain words. */
function plainRemedy(remedy: string): string {
  return remedy.replace(/^([a-z_]+)/, (whole, type: string) => short(type));
}

const money = (value: Money|undefined) => value?.display ?? '—';
const ZERO = (value: Money) => /^0+$/.test(value.atomic);

/** The fill-in format inside a code block, so Sokosumi keeps one field per line. */
export function formatBlock(format: string): string {
  return ['```text', format, '```'].join('\n');
}

export function needsInput(name: string, problems: string[], format: string): string {
  return [
    `**${name} needs a few more details.** Missing or unclear: ${problems.join('; ')}.`,
    '',
    'Reply with these lines. Copy them, change the values, and keep one field per line:',
    '',
    formatBlock(format),
  ].join('\n');
}

const FOOTER = '_Prepared by Tally\'s contract engine without an AI model. Every amount and date is computed by Tally\'s code._';

function modeLine(simulated: boolean): string {
  return simulated ?
    '**Paper contract (SIMULATED).** No real money moves on this server.' :
    '**Live on Cardano preprod.** Payments use test USDM.';
}

// ---------------------------------------------------------------------------
// Deal Desk
// ---------------------------------------------------------------------------

export function renderDraft(draft: DraftResult): string {
  const timeline = draft.firstMilestoneTimeline;
  const first = draft.milestones[0];
  const several = draft.milestones.length > 1;
  const followUp = (value: string) => (value === 'none' ? '' : ` (${plain(value)})`);
  const lines = [
    `## Tally contract draft: ${several ? `${draft.milestones.length} milestones` : first?.title}`,
    modeLine(draft.mode !== 'live'),
    '',
    '**In short**',
    `- Contract type: ${plain(draft.template.id)}.`,
    `- The buyer pays **${money(first?.amount)}** into escrow${several ? ' for the first milestone' : ''} by **${timeline.payBy.singapore}**.`,
    `- The seller delivers by **${timeline.deliverBy.singapore}**.`,
    `- If nobody disputes, the seller is paid around **${timeline.expectedPayoutIfNoDispute.singapore}**.`,
    ...(first ? [`- If the buyer wins a dispute: the seller gets **${money(first.buyerWins.toSeller)}** and the buyer gets **${money(first.buyerWins.toBuyer)}** back${followUp(first.buyerWinsFollowUp)}.`] : []),
    '',
    '### Where the money goes',
    '| Milestone | Price | Delivered as agreed | Buyer wins a dispute |',
    '| --- | --- | --- | --- |',
    ...draft.milestones.map((item) =>
      `| ${item.index + 1}. ${item.title} | ${money(item.amount)} | seller ${money(item.sellerWins.toSeller)} | seller ${money(item.buyerWins.toSeller)}, buyer ${money(item.buyerWins.toBuyer)} |`),
    ...draft.milestones.filter((item) => item.escrows.length > 1).map((item) =>
      `\nMilestone ${item.index + 1} is held in ${item.escrows.length} parts: ${item.escrows.map((escrow) => `${escrow.role} ${money(escrow.amount)}`).join(' and ')}.`),
    '',
    `### Key dates${several ? ' for the first milestone' : ''} (Singapore time)`,
    '| Step | When |',
    '| --- | --- |',
    `| Fund the escrow by | ${timeline.payBy.singapore} |`,
    `| Deliver by | ${timeline.deliverBy.singapore} |`,
    `| Last moment to dispute, if delivered on the last day | ${timeline.inspectionEndsIfDeliveredLast.singapore} |`,
    `| Payout if nobody disputes | ${timeline.expectedPayoutIfNoDispute.singapore} |`,
    `| Any dispute must finish by | ${timeline.disputeWindowEndsAt.singapore} |`,
    '',
    `The money can stay locked for at most ${draft.maxLock.perMilestone.display} per milestone${several ? ` (${draft.maxLock.wholeContractWorstCase.display} for the whole contract in the worst case)` : ''}.`,
    '',
    '### Proof of delivery',
    ...draft.evidence.delivery.map((rule) => `- ${plainRule(rule)}`),
    '',
    `**Who decides a quality dispute:** ${plainJudge(draft.judge.type)}`,
    '',
    '### If there is a dispute',
  ];
  const window = (tier: number) => draft.disputes.tierWindows[`tier${tier}`]?.display;
  const fee = (tier: 1|2|3) => {
    const value = draft.fees.perTier[`tier${tier}`];
    return ZERO(value) ? '' : ` Fee: ${money(value)}, ${plain(draft.fees.rule)}.`;
  };
  const steps: {[tier: number]: string} = {
    1: 'The parties negotiate.',
    2: 'The agreed evidence decides.',
    3: 'A human mediator decides.',
  };
  draft.disputes.tiers.forEach((tier, position) => {
    const options = tier === 1 && first?.tier1Options.length ?
      ` They can agree to: ${first.tier1Options.map((option) => `${short(option.outcome)} (seller ${money(option.payout.toSeller)}, buyer ${money(option.payout.toBuyer)})`).join('; ')}.` : '';
    lines.push(`${position + 1}. **${steps[tier]}** Up to ${window(tier) ?? 'the template window'}.${options}${fee(tier)}`);
  });
  lines.push('', `If the mediator does not rule in time, the ${draft.disputes.tier3TimeoutWinner} wins. ${draft.fees.note}`);

  const before = [
    ...draft.placeholders.map((item) => `- Add ${PLAIN_FIELDS[item.field] ?? item.field}${item.milestoneIndex === null ? '' : ` (milestone ${item.milestoneIndex + 1})`}.`),
    ...draft.defaultsApplied.map((item) => `- Filled in for you: ${item}.`),
    ...draft.normalized.map((item) => `- Adjusted: ${item}.`),
    ...(draft.demoWindowsActive ? ['- This server uses shortened demo windows. A production contract uses the template windows.'] : []),
  ];
  if (before.length) lines.push('', '### Before you sign', ...before);
  if (!draft.liveDeadlineCheck.ok) lines.push('', '### This would fail on a live server', ...draft.liveDeadlineCheck.problems.map((item) => `- ${item}`));
  lines.push(
    '',
    '**Next step:** Fill in the items above, then create the contract in Tally. Both parties sign the final terms there.',
    'You can still change the remedy, the seller\'s share, the inspectors, and how the deal splits into milestones.',
    '',
    '---',
    '',
    '### Technical details',
    `Template \`${draft.template.id}\` version ${draft.template.version}. Remedy \`${draft.remedy.type}\`${draft.remedy.sellerSharePercent ? ` (seller share ${draft.remedy.sellerSharePercent}%)` : ''}.`,
    'The request below creates this contract in Tally. Replace every `<...>` value first.',
    '```json',
    JSON.stringify(draft.createRequest, null, 2),
    '```',
    '',
    FOOTER,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mediator
// ---------------------------------------------------------------------------

/** The case file fields the template answer reads (from CoworkerTools.disputeCase). */
export interface CaseView {
  label: string;
  canRuleNow: boolean;
  nextStep: string;
  contract: {id: string; template: {id: string}; judge: string; remedy: string};
  milestone: {index: number; title: string; amount: Money; state: string};
  deliveryEvidenceCheck: Array<{met: boolean; rule: string; found: number}>;
  evidence: Array<{type: string; submittedByRole: string; signer: {namedJudge: boolean; whitelisted: boolean}|null; submittedAt: {singapore: string}}>;
}

export interface RulingView {
  options: RulingOption[];
  defaultIfNoRuling: {winner: string; appliesAt: {singapore: string}|null};
}

function renderRulingOption(option: RulingOption): string {
  const payout = option.payout ? `the seller gets ${money(option.payout.toSeller)} and the buyer gets ${money(option.payout.toBuyer)}` : 'the payout waits for the follow-up below';
  const parts = [`- **If the ${option.winner} wins:** ${payout}.`];
  if (option.fee) parts.push(`Fee: ${money(option.fee.amount)}${option.fee.paidBy ? `, paid by the ${option.fee.paidBy}` : ''}.`);
  for (const item of option.obligations) parts.push(`The ${item.party} must ${plain(item.action)} by ${item.dueAt.singapore}.`);
  if (option.followUp) {
    parts.push(option.followUp.kind === 'return' ?
      `The goods must be returned by ${option.followUp.deadline.singapore}.` :
      `The seller must redo the work by ${option.followUp.deadline.singapore}.`);
  }
  parts.push(`Then: ${plain(option.stateAfterRuling)}.`);
  if (option.reliabilityIfSettled) {
    parts.push(`Track record: ${plain(option.reliabilityIfSettled.state)}${option.reliabilityIfSettled.fault ? `, the ${option.reliabilityIfSettled.fault} at fault` : ''}.`);
  }
  return parts.join(' ');
}

const signerText = (signer: CaseView['evidence'][number]['signer']) =>
  (signer ? (signer.namedJudge ? 'the named inspector' : signer.whitelisted ? 'an approved inspector' : 'an unlisted signer') : 'not signed');

export function renderCase(caseFile: CaseView, ruling: RulingView|null): string {
  const lines = [
    `## Mediation case: milestone ${caseFile.milestone.index + 1}, ${caseFile.milestone.title}`,
    `**Draft for the human mediator.** This is not a ruling, and it makes no recommendation. Only the mediator decides. ${caseFile.label === 'LIVE' ? 'Live contract on Cardano preprod.' : 'Paper contract (SIMULATED).'}`,
    '',
    '**In short**',
    `- Contract \`${caseFile.contract.id}\`, milestone ${caseFile.milestone.index + 1}: ${caseFile.milestone.title}, **${caseFile.milestone.amount.display}**.`,
    `- Now: ${plain(caseFile.milestone.state)}. ${caseFile.nextStep}`,
    `- Contract type: ${plain(caseFile.contract.template.id)}. Remedy: ${plainRemedy(caseFile.contract.remedy)}.`,
    `- Who decides a quality dispute: ${plainJudge(caseFile.contract.judge)}`,
    '',
    '### Required proof of delivery',
    '| Requirement | Status |',
    '| --- | --- |',
    ...caseFile.deliveryEvidenceCheck.map((check) => `| ${plainRule(check.rule)} | ${check.met ? 'Met' : 'Missing'} (${check.found} on file) |`),
    '',
    '### Evidence on file',
    ...(caseFile.evidence.length ? [
      '| Evidence | From | Signed by | Sent (Singapore time) |',
      '| --- | --- | --- | --- |',
      ...caseFile.evidence.map((item) => `| ${capital(plain(item.type))} | the ${item.submittedByRole} | ${signerText(item.signer)} | ${item.submittedAt.singapore} |`),
    ] : ['No evidence on file yet.']),
  ];
  if (ruling) {
    lines.push('', '### What each ruling would do', ...ruling.options.map(renderRulingOption), '',
      `If nobody rules by ${ruling.defaultIfNoRuling.appliesAt?.singapore ?? 'the deadline'}, the ${ruling.defaultIfNoRuling.winner} wins by default.`);
  }
  lines.push('',
    `**Next step:** ${caseFile.canRuleNow ? 'The mediator reviews the evidence, decides, and signs the ruling in the Mediation desk.' : 'Wait for the step named under "Now".'}`,
    '',
    '---',
    '',
    `_Template \`${caseFile.contract.template.id}\`, state \`${caseFile.milestone.state}\`. ${FOOTER.slice(1)}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Trust Check
// ---------------------------------------------------------------------------

type SummaryCounts = {[key: string]: number};

/** The profile fields the template answer reads (from CoworkerTools.reliabilityProfile). */
export interface ProfileView {
  entity: {id: string; displayName: string; kycStatus: string; kycTier: string; createdAt: string};
  scoringPolicy: {version: string; provisional: boolean};
  scores: Array<{category: string; role: string; score: number; lowerBound: number; events: {success: number; failure: number}}>;
  contractSummary: {live: SummaryCounts; simulated: SummaryCounts};
  deals: Array<{label: string; role: string; counterpartyId: string; amount: Money; state: string; disputed: boolean; disputeWinner: string|null; ignoredRuling: boolean|null}>;
}

export function renderProfile(data: ProfileView): string {
  const total = (key: string) => (data.contractSummary.live[key] ?? 0) + (data.contractSummary.simulated[key] ?? 0);
  const row = (title: string, key: string) => `| ${title} | ${data.contractSummary.live[key] ?? 0} | ${data.contractSummary.simulated[key] ?? 0} |`;
  const result = (deal: ProfileView['deals'][number]) => {
    if (!deal.disputed) return plain(deal.state);
    const winner = deal.disputeWinner ? `dispute won by the ${deal.disputeWinner}` : 'dispute still open';
    return `${winner}${deal.ignoredRuling ? '; ignored the ruling' : ''}`;
  };
  const lines = [
    `## ${data.entity.displayName}`,
    `\`${data.entity.id}\` · KYC ${data.entity.kycStatus} (${data.entity.kycTier} tier) · on Tally since ${String(data.entity.createdAt).slice(0, 10)}`,
    '',
    '**In short**',
    `- ${total('milestones')} milestones on record: ${data.contractSummary.live.milestones ?? 0} live and ${data.contractSummary.simulated.milestones ?? 0} simulated.`,
    `- Disputes: ${total('disputed')}, lost: ${total('disputesLost')}. Rulings ignored: ${total('rulingsIgnored')}. Late deliveries: ${total('lateDeliveries')}.`,
    '- These are facts from Tally records, not a verdict or a credit rating.',
    '',
    '### Record',
    '| | Live | Simulated |',
    '| --- | --- | --- |',
    row('Milestones', 'milestones'), row('Still open', 'open'), row('Disputed', 'disputed'), row('Disputes lost', 'disputesLost'),
    row('Rulings ignored', 'rulingsIgnored'), row('Late deliveries', 'lateDeliveries'), row('At fault', 'atFault'),
    '',
    '### Scores',
    ...(data.scores.length ? [
      '| Category (role) | Score | Lower bound | Track record |',
      '| --- | --- | --- | --- |',
      ...data.scores.map((score) => `| ${plain(score.category)} (as ${score.role}) | ${score.score.toFixed(2)} | ${score.lowerBound.toFixed(2)} | ${score.events.success} ok, ${score.events.failure} failed |`),
    ] : ['No scored events yet.']),
    ...(data.scoringPolicy.provisional ? ['', `The scoring policy (${data.scoringPolicy.version}) is provisional. Read the scores as counts of successes and failures, not as a calibrated rating.`] : []),
    '',
    '### Deals',
    ...(data.deals.length ? [
      '| Deal | Role | Amount | Result |',
      '| --- | --- | --- | --- |',
      ...data.deals.map((deal) => `| ${deal.label} with \`${deal.counterpartyId}\` | ${deal.role} | ${money(deal.amount)} | ${result(deal)} |`),
    ] : ['No Tally deals yet.']),
    '',
    'Tally does not set contract terms from scores yet. A contract can still add protection: a holdback, an inspector, or smaller milestones.',
    '',
    '**Next step:** Ask Tally Deal Desk to draft a contract with the protections you want.',
    '',
    '---',
    '',
    FOOTER,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// For the model
// ---------------------------------------------------------------------------

/** The plain words as a list for the system prompt. */
export function plainWordsForPrompt(): string {
  return [
    '## Plain words for engine names',
    '',
    'In the answer, write the plain words. Use the engine names only in the Technical details section.',
    '',
    ...Object.entries(PLAIN_WORDS).map(([name, words]) => `- \`${name}\`: ${words}`),
  ].join('\n');
}
