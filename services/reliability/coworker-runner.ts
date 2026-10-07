/**
 * @fileoverview Runs one Coworker on one Task text. With a model provider,
 * the model reads free text and calls the tools. Without one, the Coworker
 * reads a fill-in format and answers from templates. Both paths call the
 * same tools, so every number comes from Tally's code.
 */

import {readFileSync} from 'node:fs';
import type {RemedyType} from '../../packages/reliability/src/contract-lifecycle/types';
import {ModelError, runWithTools, type ModelProvider, type ParamSchema, type RunnableTool} from './coworker-models';
import type {CoworkerTools, DraftInput, DraftResult, Money, RulingOption, ToolResult} from './coworker-tools';

export const COWORKER_SLUGS = ['deal-desk', 'mediator', 'trust-check'] as const;
export type CoworkerSlug = typeof COWORKER_SLUGS[number];

export const COWORKER_NAMES: {[slug in CoworkerSlug]: string} = {
  'deal-desk': 'Tally Deal Desk',
  'mediator': 'Tally Mediator',
  'trust-check': 'Tally Trust Check',
};

/** Longest result Sokosumi accepts in a completion event. */
export const RESULT_LIMIT_BYTES = 1_048_576;

export type CoworkerAnswer =
  {kind: 'answer'; text: string; mode: 'model'|'fill-in'; toolCalls: number}|
  {kind: 'needs_input'; message: string};

// ---------------------------------------------------------------------------
// Fill-in format
// ---------------------------------------------------------------------------

/** The format each Coworker shows when it cannot read a request. */
export const FILL_IN_FORMATS: {[slug in CoworkerSlug]: string} = {
  'deal-desk': [
    'template: physical        (or: digital)',
    'item: Lot 1, 1,200 kg green arabica, Grade A',
    'amount: 4000              (test USDM)',
    'remedy: partial 70        (or: refund, refund with return, redo)',
    'description: Green arabica, washed      (physical)',
    'quantity: 1200                          (physical)',
    'unit: kg                                (physical)',
    'spec sha256: <64 hex characters>        (physical; optional)',
    'inspectors: lab-a, lab-b                (physical; optional)',
    'judge: lab-b                            (physical; optional)',
    'file sha256: <64 hex characters>        (digital; optional)',
    'milestone: Lot 2 | 2500                 (repeat for more milestones)',
  ].join('\n'),
  'mediator': ['contract: <contract id>', 'milestone: 0'].join('\n'),
  'trust-check': ['company: <company name or Tally id>', 'counterparty: <Tally id>   (optional)'].join('\n'),
};

/** Reads "key: value" lines, or a JSON object. Keys are case-insensitive. */
export function readFields(text: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const add = (key: string, value: string) => {
    const name = key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    const clean = value.replace(/\s+\(.*\)\s*$/, '').trim();
    if (!name || !clean) return;
    fields.set(name, [...(fields.get(name) ?? []), clean]);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as {[key: string]: unknown};
      for (const [key, item] of Object.entries(value)) {
        for (const entry of Array.isArray(item) ? item : [item]) if (entry !== null && entry !== undefined) add(key, String(entry));
      }
      return fields;
    } catch {
      // Not JSON: read it as lines.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*:\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) add(match[1], match[2]);
  }
  return fields;
}

const first = (fields: Map<string, string[]>, ...names: string[]): string|undefined => {
  for (const name of names) {
    const value = fields.get(name)?.[0];
    if (value) return value;
  }
  return undefined;
};

/** Plain text "partial 70", "refund with return", "redo" → a remedy input. */
export function readRemedy(value: string|undefined): {remedy?: DraftInput['remedy']; problem?: string} {
  if (!value) return {};
  const text = value.toLowerCase();
  const share = /(\d+(?:\.\d+)?)\s*%?/.exec(text)?.[1];
  let type: RemedyType|null = null;
  if (text.includes('partial')) type = 'partial_release';
  else if (text.includes('redo') || text.includes('replace')) type = 'redo_or_replace';
  else if (text.includes('return') && !text.includes('no return')) type = 'full_refund_with_return';
  else if (text.includes('refund')) type = 'full_refund_no_return';
  if (!type) return {problem: `remedy "${value}" is not one of: partial <seller share>, refund, refund with return, redo`};
  if (type === 'partial_release' && !share) return {problem: 'remedy partial needs the share the seller keeps, for example "partial 70"'};
  return {remedy: type === 'partial_release' ? {type, sellerSharePercent: share} : {type}};
}

export function readDealDesk(text: string): {input?: DraftInput; problems: string[]} {
  const fields = readFields(text);
  const problems: string[] = [];
  const templateText = (first(fields, 'template') ?? '').toLowerCase();
  const templateId = templateText.startsWith('phys') ? 'physical-objective-spec' :
    templateText.startsWith('dig') ? 'digital-machine-checkable' : templateText || undefined;
  if (!templateId) problems.push('template (physical or digital)');
  const milestones: DraftInput['milestones'] = [];
  for (const line of fields.get('milestone') ?? []) {
    const [title, amount] = line.split('|').map((part) => part.trim());
    if (title && amount) milestones.push({title, amount});
    else problems.push(`milestone "${line}" (use: title | amount)`);
  }
  const item = first(fields, 'item', 'title');
  const amount = first(fields, 'amount', 'price');
  if (item && amount) milestones.unshift({title: item, amount: amount.replace(/\s*(test\s*)?usdm\s*$/i, '')});
  else if (!milestones.length) problems.push('item and amount');
  const deliverable: {[key: string]: unknown} = {};
  const put = (key: string, value: string|undefined, number = false) => {
    if (value === undefined) return;
    if (number) {
      const parsed = Number(value.replace(/,/g, ''));
      if (Number.isFinite(parsed)) deliverable[key] = parsed;
      else problems.push(`${key} must be a number`);
    } else deliverable[key] = value;
  };
  if (templateId === 'physical-objective-spec') {
    put('specDocumentSha256', first(fields, 'spec sha256', 'spec hash', 'specdocumentsha256'));
    put('description', first(fields, 'description'));
    put('quantity', first(fields, 'quantity'), true);
    put('unit', first(fields, 'unit'));
    put('grade', first(fields, 'grade'));
    put('incoterm', first(fields, 'incoterm'));
  } else if (templateId === 'digital-machine-checkable') {
    put('expectedSha256', first(fields, 'file sha256', 'sha256', 'expectedsha256', 'file hash'));
    put('fileName', first(fields, 'file name', 'filename'));
  }
  const remedy = readRemedy(first(fields, 'remedy'));
  if (remedy.problem) problems.push(remedy.problem);
  const inspectors = first(fields, 'inspectors')?.split(',').map((item) => item.trim()).filter(Boolean);
  if (problems.length || !templateId) return {problems};
  return {
    problems,
    input: {
      templateId,
      // Every milestone in a fill-in request shares the same deliverable fields.
      milestones: milestones.map((milestone) => ({...milestone, deliverable: {...deliverable}})),
      ...(remedy.remedy ? {remedy: remedy.remedy} : {}),
      ...(inspectors?.length ? {inspectors} : {}),
      ...(first(fields, 'judge') ? {judgeInspector: first(fields, 'judge')} : {}),
      ...(first(fields, 'funding start', 'funding starts at') ? {fundingStartsAt: first(fields, 'funding start', 'funding starts at')} : {}),
    },
  };
}

export function readMediator(text: string): {contractId?: string; milestone: string; problems: string[]} {
  const fields = readFields(text);
  const contractId = first(fields, 'contract', 'contract id', 'contractid');
  return {contractId, milestone: first(fields, 'milestone') ?? '0', problems: contractId ? [] : ['contract (the contract id)']};
}

export function readTrustCheck(text: string): {company?: string; counterparty?: string; problems: string[]} {
  const fields = readFields(text);
  const company = first(fields, 'company', 'entity', 'entity id');
  return {company, counterparty: first(fields, 'counterparty'), problems: company ? [] : ['company (a name or a Tally id)']};
}

/** Problems that stop a fill-in request. Empty when the request is readable. */
export function fillInProblems(slug: CoworkerSlug, text: string): string[] {
  if (slug === 'deal-desk') return readDealDesk(text).problems;
  if (slug === 'mediator') return readMediator(text).problems;
  return readTrustCheck(text).problems;
}

export function needsInputMessage(slug: CoworkerSlug, problems: string[]): string {
  return [
    `${COWORKER_NAMES[slug]} could not read this request. Missing or unclear: ${problems.join('; ')}.`,
    '',
    'Reply in this format (one field per line):',
    '',
    FILL_IN_FORMATS[slug],
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Template answers (no model)
// ---------------------------------------------------------------------------

const money = (value: Money|undefined) => value?.display ?? '—';
const NO_MODEL_NOTE = '_Answered without a language model. Every value comes from Tally\'s contract engine._';

function closing(set: string[], choice: string[], next: string): string {
  return ['', '**Set by Tally\'s code:**', ...set.map((item) => `- ${item}`), '',
    '**Still your choice:**', ...choice.map((item) => `- ${item}`), '', `**Next step:** ${next}`].join('\n');
}

export function renderDraft(draft: DraftResult): string {
  const timeline = draft.firstMilestoneTimeline;
  const lines = [
    `# Tally contract draft (${draft.mode === 'live' ? 'live on Cardano preprod' : 'paper, SIMULATED'})`,
    NO_MODEL_NOTE,
    '',
    `**Template:** ${draft.template.id} (judge: ${draft.template.judge})`,
    `**Remedy:** ${draft.remedy.type}${draft.remedy.sellerSharePercent ? ` (seller keeps ${draft.remedy.sellerSharePercent}% if the buyer wins)` : ''}`,
    '',
    '## Milestones and escrows',
    '| Milestone | Amount | Escrows | If the seller wins | If the buyer wins |',
    '| --- | --- | --- | --- | --- |',
    ...draft.milestones.map((item) => `| ${item.index + 1}. ${item.title} | ${money(item.amount)} | ${item.escrows.map((escrow) => `${escrow.role} ${money(escrow.amount)}`).join(', ')} | seller ${money(item.sellerWins.toSeller)}, buyer ${money(item.sellerWins.toBuyer)} | seller ${money(item.buyerWins.toSeller)}, buyer ${money(item.buyerWins.toBuyer)}${item.buyerWinsFollowUp === 'none' ? '' : ` (${item.buyerWinsFollowUp.replaceAll('_', ' ')})`} |`),
    '',
    '## What proves delivery',
    ...draft.evidence.delivery.map((rule) => `- ${rule}`),
    `- Judge: ${draft.judge.type}${draft.judge.inspector ? `, inspector ${draft.judge.inspector}` : ''}`,
    '',
    '## Timeline if funding starts now',
    '| Step | Singapore time |',
    '| --- | --- |',
    `| Pay by | ${timeline.payBy.singapore} |`,
    `| Deliver by | ${timeline.deliverBy.singapore} |`,
    `| Last moment to dispute (if delivered last) | ${timeline.inspectionEndsIfDeliveredLast.singapore} |`,
    `| Release at unlock | ${timeline.unlockAt.singapore} |`,
    `| Expected payout if no dispute | ${timeline.expectedPayoutIfNoDispute.singapore} |`,
    `| Dispute window ends | ${timeline.disputeWindowEndsAt.singapore} |`,
    '',
    `Longest lock per milestone: ${draft.maxLock.perMilestone.display}. Whole contract, worst case: ${draft.maxLock.wholeContractWorstCase.display} (${draft.maxLock.fundingSchedule} funding).`,
    '',
    '## If something goes wrong',
    `Dispute tiers: ${draft.disputes.tiers.join(', ')}. Without a Tier 3 ruling, the ${draft.disputes.tier3TimeoutWinner} wins.`,
    ...draft.milestones.flatMap((item) => item.tier1Options.length ?
      [`Tier 1 options for milestone ${item.index + 1}: ${item.tier1Options.map((option) => `${option.outcome} (seller ${money(option.payout.toSeller)}, buyer ${money(option.payout.toBuyer)})`).join('; ')}.`] : []),
    `Fees: Tier 1 ${money(draft.fees.perTier.tier1)}, Tier 2 ${money(draft.fees.perTier.tier2)}, Tier 3 ${money(draft.fees.perTier.tier3)}, rule ${draft.fees.rule}. ${draft.fees.note}`,
  ];
  if (draft.defaultsApplied.length || draft.placeholders.length || draft.normalized.length || draft.demoWindowsActive) {
    lines.push('', '## Defaults and placeholders',
      ...draft.defaultsApplied.map((item) => `- Default: ${item}`),
      ...draft.normalized.map((item) => `- Normalized: ${item}`),
      ...draft.placeholders.map((item) => `- Fill before signing: ${item.field}${item.milestoneIndex === null ? '' : ` (milestone ${item.milestoneIndex + 1})`}`),
      ...(draft.demoWindowsActive ? ['- This server uses shortened demo windows. A production contract uses the template windows.'] : []));
  }
  if (!draft.liveDeadlineCheck.ok) lines.push('', '## Live check', ...draft.liveDeadlineCheck.problems.map((item) => `- ${item}`));
  lines.push('', '## Create request', 'Replace every `<...>` value. The parties sign the frozen terms in Tally.', '```json', JSON.stringify(draft.createRequest, null, 2), '```');
  lines.push(closing(['Escrow amounts, payouts, deadlines, fees, and the lock times above'],
    ['The remedy, the seller share, the inspectors, and the milestone split'], 'Fill every placeholder, then create the contract in Tally with the create request.'));
  return lines.join('\n');
}

function renderRulingOption(option: RulingOption): string {
  const payout = option.payout ? `seller ${money(option.payout.toSeller)}, buyer ${money(option.payout.toBuyer)}` : 'after the follow-up';
  const fee = option.fee ? `${money(option.fee.amount)} paid by the ${option.fee.paidBy}` : 'none';
  const obligations = option.obligations.map((item) => `${item.party} must ${item.action.replaceAll('_', ' ')} by ${item.dueAt.singapore}`).join('; ') || 'none';
  const follow = option.followUp ? ` Follow-up: ${option.followUp.kind} by ${option.followUp.deadline.singapore}.` : '';
  const record = option.reliabilityIfSettled ? ` Reliability record: ${option.reliabilityIfSettled.state}${option.reliabilityIfSettled.fault ? `, ${option.reliabilityIfSettled.fault} at fault` : ''}.` : '';
  return `- **${option.winner} wins:** next state ${option.stateAfterRuling}; payout ${payout}; fee ${fee}; obligations: ${obligations}.${follow}${record}`;
}

// ---------------------------------------------------------------------------
// Tools for the model
// ---------------------------------------------------------------------------

const MILESTONE_PARAM: ParamSchema = {type: 'string', description: 'Milestone number (0 for the first) or milestone id'};

export function coworkerTools(slug: CoworkerSlug, tools: CoworkerTools): RunnableTool[] {
  const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
  const ref = (value: unknown) => (/^\d+$/.test(str(value)) ? Number(str(value)) : str(value));
  if (slug === 'deal-desk') {
    return [
      {name: 'listTemplates', description: 'Every contract template with status, judge, evidence rules, deliverable fields, remedies, windows, fees, and limits.',
        parameters: {type: 'object', properties: {}}, run: () => tools.listTemplates()},
      {name: 'draftContract', description: 'Validate a proposal with the real contract engine. Returns every number the parties will sign, or an engine error.',
        parameters: {
          type: 'object', required: ['templateId', 'milestones'],
          properties: {
            templateId: {type: 'string', description: 'A template id from listTemplates'},
            milestones: {type: 'array', items: {type: 'object', required: ['title', 'amount'], properties: {
              title: {type: 'string'},
              amount: {type: 'string', description: 'Price in test USDM as text, for example "4000"'},
              expectedSha256: {type: 'string', description: 'Digital template: SHA-256 of the agreed file'},
              fileName: {type: 'string'},
              specDocumentSha256: {type: 'string', description: 'Physical template: SHA-256 of the specification'},
              description: {type: 'string'},
              quantity: {type: 'number'},
              unit: {type: 'string'},
              grade: {type: 'string'},
              incoterm: {type: 'string'},
            }}},
            remedyType: {type: 'string', enum: ['partial_release', 'full_refund_no_return', 'full_refund_with_return', 'redo_or_replace']},
            sellerSharePercent: {type: 'string', description: 'partial_release only: the share the seller keeps, for example "70"'},
            inspectors: {type: 'array', items: {type: 'string'}},
            judgeInspector: {type: 'string'},
            fundingStartsAt: {type: 'string', description: 'ISO time. Omit for now.'},
          },
        },
        run: (args) => {
          const milestones = Array.isArray(args.milestones) ? args.milestones : [];
          const deliverableKeys = ['expectedSha256', 'fileName', 'specDocumentSha256', 'description', 'quantity', 'unit', 'grade', 'incoterm'];
          const input: DraftInput = {
            templateId: str(args.templateId),
            milestones: milestones.map((item) => {
              const entry = (typeof item === 'object' && item ? item : {}) as {[key: string]: unknown};
              return {
                title: str(entry.title), amount: str(entry.amount),
                deliverable: Object.fromEntries(deliverableKeys.filter((key) => entry[key] !== undefined && entry[key] !== '').map((key) => [key, entry[key]])),
              };
            }),
            ...(args.remedyType ? {remedy: {type: str(args.remedyType) as RemedyType, ...(args.sellerSharePercent ? {sellerSharePercent: str(args.sellerSharePercent)} : {})}} : {}),
            ...(Array.isArray(args.inspectors) ? {inspectors: args.inspectors.map(str)} : {}),
            ...(args.judgeInspector ? {judgeInspector: str(args.judgeInspector)} : {}),
            ...(args.fundingStartsAt ? {fundingStartsAt: str(args.fundingStartsAt)} : {}),
          };
          return tools.draftContract(input);
        }},
    ];
  }
  if (slug === 'mediator') {
    const caseParams: ParamSchema = {type: 'object', required: ['contractId', 'milestone'], properties: {contractId: {type: 'string'}, milestone: MILESTONE_PARAM}};
    return [
      {name: 'disputeCase', description: 'The full record of one milestone: terms, state, deadlines, evidence with signer status, history, audit trail, canRuleNow, and nextStep.',
        parameters: caseParams, run: (args) => tools.disputeCase(str(args.contractId), ref(args.milestone))},
      {name: 'rulingOptions', description: 'What a buyer win and a seller win would do, simulated by the real engine on a copy of the contract.',
        parameters: caseParams, run: (args) => tools.rulingOptions(str(args.contractId), ref(args.milestone))},
      {name: 'rulingSigningPayload', description: 'The exact bytes the human mediator signs for a ruling, and the request that submits it.',
        parameters: {type: 'object', required: ['contractId', 'milestone', 'winner', 'reason'], properties: {
          contractId: {type: 'string'}, milestone: MILESTONE_PARAM, winner: {type: 'string', enum: ['buyer', 'seller']}, reason: {type: 'string'},
        }},
        run: (args) => tools.rulingSigningPayload(str(args.contractId), ref(args.milestone), str(args.winner) === 'seller' ? 'seller' : 'buyer', str(args.reason))},
    ];
  }
  return [
    {name: 'findEntities', description: 'Companies whose Tally id or display name contains the query. Never choose one silently.',
      parameters: {type: 'object', required: ['query'], properties: {query: {type: 'string'}}}, run: (args) => tools.findEntities(str(args.query))},
    {name: 'reliabilityProfile', description: 'Scores, terms decisions, and contract history of one company, from Tally records.',
      parameters: {type: 'object', required: ['entityId'], properties: {entityId: {type: 'string'}, counterpartyId: {type: 'string'}}},
      run: (args) => tools.reliabilityProfile(str(args.entityId), args.counterpartyId ? {counterpartyId: str(args.counterpartyId)} : {})},
  ];
}

const INSTRUCTIONS = new URL('./coworkers/', import.meta.url);

/** The shared rules, then the Coworker's own file, then the tool names in use. */
export function systemPrompt(slug: CoworkerSlug): string {
  const shared = readFileSync(new URL('shared-rules.md', INSTRUCTIONS), 'utf8');
  const own = readFileSync(new URL(`${slug}.md`, INSTRUCTIONS), 'utf8');
  return `${shared}\n\n---\n\n${own}\n\n---\n\nYou are ${COWORKER_NAMES[slug]}. Call the tools by the names given to you. Answer in Markdown.`;
}

// ---------------------------------------------------------------------------
// One Task
// ---------------------------------------------------------------------------

/** The case file fields the template answer reads (from CoworkerTools.disputeCase). */
interface CaseView {
  label: string;
  canRuleNow: boolean;
  nextStep: string;
  contract: {id: string; template: {id: string}; judge: string; remedy: string};
  milestone: {index: number; title: string; amount: Money; state: string};
  deliveryEvidenceCheck: Array<{met: boolean; rule: string; found: number}>;
  evidence: Array<{type: string; submittedByRole: string; signer: {namedJudge: boolean; whitelisted: boolean}|null; submittedAt: {singapore: string}}>;
}

type SummaryCounts = {[key: string]: number};

/** The profile fields the template answer reads (from CoworkerTools.reliabilityProfile). */
interface ProfileView {
  entity: {id: string; displayName: string; kycStatus: string; kycTier: string; createdAt: string};
  scoringPolicy: {version: string; provisional: boolean};
  scores: Array<{category: string; role: string; score: number; lowerBound: number; events: {success: number; failure: number}}>;
  contractSummary: {live: SummaryCounts; simulated: SummaryCounts};
  deals: Array<{label: string; role: string; counterpartyId: string; amount: Money; state: string; disputed: boolean; disputeWinner: string|null; ignoredRuling: boolean|null}>;
}

function unwrap<T>(result: ToolResult<T>): {value?: T; error?: string} {
  return result.ok ? {value: result.result} : {error: `${result.error.code}: ${result.error.message}`};
}

/** The no-model answer, or a request for input. */
export function answerFillIn(slug: CoworkerSlug, text: string, tools: CoworkerTools): CoworkerAnswer {
  const problems = fillInProblems(slug, text);
  if (problems.length) return {kind: 'needs_input', message: needsInputMessage(slug, problems)};
  if (slug === 'deal-desk') {
    const {input} = readDealDesk(text);
    const draft = unwrap(tools.draftContract(input as DraftInput));
    if (draft.error) return {kind: 'needs_input', message: `${COWORKER_NAMES[slug]}: Tally's engine rejected the proposal (${draft.error}). Fix that field and reply.\n\n${FILL_IN_FORMATS[slug]}`};
    return {kind: 'answer', mode: 'fill-in', toolCalls: 1, text: renderDraft(draft.value as DraftResult)};
  }
  if (slug === 'mediator') {
    const {contractId, milestone} = readMediator(text);
    const ref = /^\d+$/.test(milestone) ? Number(milestone) : milestone;
    const file = unwrap(tools.disputeCase(contractId as string, ref));
    if (file.error) return {kind: 'needs_input', message: `${COWORKER_NAMES[slug]}: ${file.error}. Check the contract id and the milestone.\n\n${FILL_IN_FORMATS[slug]}`};
    const caseFile = file.value as unknown as CaseView;
    const lines = [
      `# Mediation case (${caseFile.label})`,
      NO_MODEL_NOTE,
      '',
      '**DRAFT for the human mediator. This is not a ruling, and it has no recommendation: the mediator decides.**',
      '',
      `Contract ${caseFile.contract.id}, milestone ${caseFile.milestone.index + 1}: ${caseFile.milestone.title} (${caseFile.milestone.amount.display}).`,
      `Template ${caseFile.contract.template.id}; judge: ${caseFile.contract.judge}; remedy: ${caseFile.contract.remedy}.`,
      `State: ${caseFile.milestone.state}. ${caseFile.nextStep}`,
      '',
      '## Required delivery evidence',
      ...caseFile.deliveryEvidenceCheck.map((check) => `- ${check.met ? 'Met' : 'Missing'}: ${check.rule} (found ${check.found})`),
      '',
      '## Evidence',
      '| Type | From | Signer | Submitted |',
      '| --- | --- | --- | --- |',
      ...caseFile.evidence.map((item) =>
        `| ${item.type} | ${item.submittedByRole} | ${item.signer ? (item.signer.namedJudge ? 'named judge' : item.signer.whitelisted ? 'whitelisted inspector' : 'unlisted signer') : 'unsigned'} | ${item.submittedAt.singapore} |`),
    ];
    if (caseFile.canRuleNow) {
      const options = unwrap(tools.rulingOptions(contractId as string, ref));
      if (options.value) {
        lines.push('', '## What each ruling does', ...options.value.options.map(renderRulingOption),
          `If nobody rules by ${options.value.defaultIfNoRuling.appliesAt?.singapore ?? 'the deadline'}, the ${options.value.defaultIfNoRuling.winner} wins by template default.`);
      }
    }
    lines.push(closing(['Payouts, fees, obligations, and deadlines above'], ['The winner and the reason: only the human mediator decides'],
      caseFile.canRuleNow ? 'The mediator reviews the evidence, decides, and signs the ruling bytes from the Mediation desk.' : 'Wait for the step in the state line above.'));
    return {kind: 'answer', mode: 'fill-in', toolCalls: caseFile.canRuleNow ? 2 : 1, text: lines.join('\n')};
  }
  const {company, counterparty} = readTrustCheck(text);
  const matches = unwrap(tools.findEntities(company as string));
  const exact = matches.value?.find((item) => item.id === company) ??
    (matches.value?.length === 1 ? matches.value[0] : undefined);
  if (!exact) {
    const list = (matches.value ?? []).map((item) => `- ${item.displayName} (${item.id})`).join('\n');
    return {kind: 'needs_input', message: matches.value?.length ?
      `${COWORKER_NAMES[slug]}: "${company}" matches more than one company. Reply with one id:\n${list}` :
      `${COWORKER_NAMES[slug]}: Tally has no record matching "${company}". Reply with the exact Tally id.\n\n${FILL_IN_FORMATS[slug]}`};
  }
  const profile = unwrap(tools.reliabilityProfile(exact.id, counterparty ? {counterpartyId: counterparty} : {}));
  if (profile.error) return {kind: 'needs_input', message: `${COWORKER_NAMES[slug]}: ${profile.error}`};
  const data = profile.value as unknown as ProfileView;
  const summaryRow = (title: string, key: string) => `| ${title} | ${data.contractSummary.live[key]} | ${data.contractSummary.simulated[key]} |`;
  const lines = [
    `# ${data.entity.displayName} (${data.entity.id})`,
    NO_MODEL_NOTE,
    '',
    `KYC: ${data.entity.kycStatus}, ${data.entity.kycTier} tier. On Tally since ${String(data.entity.createdAt).slice(0, 10)}.`,
    '',
    '## Record at a glance',
    '| | Live | Simulated |',
    '| --- | --- | --- |',
    summaryRow('Milestones', 'milestones'), summaryRow('Open', 'open'), summaryRow('Disputed', 'disputed'),
    summaryRow('Disputes lost', 'disputesLost'), summaryRow('Rulings ignored', 'rulingsIgnored'),
    summaryRow('Late deliveries', 'lateDeliveries'), summaryRow('At fault', 'atFault'),
    '',
    '## Scores',
    ...(data.scores.length ? ['| Category | Role | Score | Lower bound | Events |', '| --- | --- | --- | --- | --- |',
      ...data.scores.map((score) =>
        `| ${score.category} | ${score.role} | ${score.score} | ${score.lowerBound} | ${score.events.success} ok, ${score.events.failure} failed |`)] : ['No scored events yet.']),
    ...(data.scoringPolicy.provisional ? ['', `Policy ${data.scoringPolicy.version} is a provisional placeholder. Read the scores as counts of successes and failures, not as a calibrated rating.`] : []),
    '',
    '## Deals',
    ...(data.deals.length ? ['| Label | Role | Counterparty | Amount | State | Dispute |', '| --- | --- | --- | --- | --- | --- |',
      ...data.deals.map((deal) =>
        `| ${deal.label} | ${deal.role} | ${deal.counterpartyId} | ${money(deal.amount)} | ${deal.state} | ${deal.disputed ? `won by the ${deal.disputeWinner ?? 'pending'}${deal.ignoredRuling ? '; ignored the ruling' : ''}` : 'none'} |`)] : ['No Tally deals yet.']),
    '',
    'This is information from Tally records, not a verdict or a credit rating. Tally does not set contract terms from scores yet.',
  ];
  lines.push(closing(['The counts, scores, and deal results above'], ['Whether and how to deal with this company'], 'Ask Tally Deal Desk to draft a contract with the protections you want.'));
  return {kind: 'answer', mode: 'fill-in', toolCalls: 2, text: lines.join('\n')};
}

/**
 * Answers one Task. A model error falls back to the fill-in path, so a
 * provider outage never blocks a readable request.
 */
export async function runCoworker(
  slug: CoworkerSlug, text: string, tools: CoworkerTools, provider: ModelProvider|null,
): Promise<CoworkerAnswer> {
  if (provider) {
    try {
      const answer = await runWithTools(provider, systemPrompt(slug), text, coworkerTools(slug, tools));
      return {kind: 'answer', mode: 'model', text: answer.text, toolCalls: answer.toolCalls};
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      const fallback = answerFillIn(slug, text, tools);
      if (fallback.kind === 'answer') return {...fallback, text: `${fallback.text}\n\n_The language model was unavailable (${error.message}); this answer used the fill-in path._`};
      throw error;
    }
  }
  return answerFillIn(slug, text, tools);
}
