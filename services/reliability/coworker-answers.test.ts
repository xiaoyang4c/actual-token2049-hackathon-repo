/**
 * @fileoverview The Coworker answers read well on Sokosumi: plain words above
 * the technical details, tables of at most four columns, and the reply format
 * in a code block so its lines stay apart.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {loadContractConfig} from './contract-config';
import {createKit, envOf, KIT_ENV} from './contract-kit';
import {seedShowcase, SHOWCASE_PARTIES} from './contract-showcase';
import {plainWordsForPrompt, PLAIN_WORDS} from './coworker-answers';
import {answerFillIn, needsInputMessage, readDealDesk, systemPrompt} from './coworker-runner';
import {CoworkerTools, type ContractSummary, type ToolResult} from './coworker-tools';

const REQUEST = ['template: physical', 'item: Lot 1, 1,200 kg green arabica, Grade A', 'amount: 4000', 'remedy: partial 70',
  'description: Green arabica, washed', 'quantity: 1200', 'unit: kg'].join('\n');
/** Engine names a reader should not meet: the ones with underscores or hyphens. */
const ENGINE_NAMES = Object.keys(PLAIN_WORDS).filter((name) => /[_-]/.test(name));

/** The part above the horizontal rule that starts the technical details. */
const readerPart = (text: string) => text.split('\n---\n')[0] as string;

function expectReadable(text: string): void {
  const reader = readerPart(text);
  for (const name of ENGINE_NAMES) expect(reader).not.toContain(name);
  expect(reader).not.toContain('whitelisted');
  for (const line of text.split('\n').filter((item) => item.startsWith('|'))) expect(line.split('|').length - 2).toBeLessThanOrEqual(4);
}

function answerText(answer: ReturnType<typeof answerFillIn>): string {
  if (answer.kind !== 'answer') throw new Error(`expected an answer, got: ${answer.message}`);
  return answer.text;
}

function ok<T>(result: ToolResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.result;
}

describe('Coworker answers', () => {
  test('Deal Desk: the short version first, plain words, and the JSON only in the technical details', () => {
    const kit = createKit();
    try {
      const tools = new CoworkerTools(null, {config: kit.service.config, templates: kit.service.templates, now: () => Date.UTC(2026, 9, 8, 2)});
      const text = answerText(answerFillIn('deal-desk', REQUEST, tools));
      expectReadable(text);
      expect(text.startsWith('## Tally contract draft: Lot 1, 1,200 kg green arabica, Grade A\n**Paper contract (SIMULATED).**')).toBe(true);
      expect(text).toContain('If the buyer wins a dispute: the seller gets **2,800 test USDM** and the buyer gets **1,200 test USDM** back.');
      expect(text).toContain('| 1. Lot 1, 1,200 kg green arabica, Grade A | 4,000 test USDM | seller 4,000 test USDM | seller 2,800 test USDM, buyer 1,200 test USDM |');
      expect(text).toContain('**Who decides a quality dispute:** the named inspector\'s signed lab report. Pass: the seller wins. Fail: the buyer wins.');
      const technical = text.split('\n---\n')[1] ?? '';
      expect(technical).toContain('Template `physical-objective-spec`');
      expect(technical).toContain('```json');
    } finally {
      kit.close();
    }
  });

  test('Deal Desk: a milestone line that repeats the item asks first; a real second lot shows the total', () => {
    const kit = createKit();
    try {
      const tools = new CoworkerTools(null, {config: kit.service.config, templates: kit.service.templates, now: () => Date.UTC(2026, 9, 8, 2)});
      // The case from the chat: the item already is milestone 1, so "Lot 1 | 4000" would double the deal.
      const repeated = answerFillIn('deal-desk', `${REQUEST}\nmilestone: Lot 1 | 4000`, tools);
      expect(repeated.kind).toBe('needs_input');
      expect(repeated.kind === 'needs_input' && repeated.message).toContain('milestone "Lot 1 | 4000" repeats the item');
      expect(readDealDesk(`${REQUEST}\nmilestone: lot 1, 1,200 KG green arabica, grade a | 4000`).problems).toHaveLength(1);
      expect(readDealDesk(`${REQUEST}\nmilestone: Lot 10 | 4000`).problems).toEqual([]);
      const two = answerText(answerFillIn('deal-desk', `${REQUEST}\nmilestone: Lot 2 | 2500`, tools));
      expect(two).toContain('- Total: **6,500 test USDM** in **2 milestones**.');
      expect(two).toContain('| 2. Lot 2 | 2,500 test USDM |');
      // One lot: no total line, the price is the total.
      expect(answerText(answerFillIn('deal-desk', REQUEST, tools))).not.toContain('- Total:');
    } finally {
      kit.close();
    }
  });

  test('a request for input shows the format in a code block', () => {
    const message = needsInputMessage('deal-desk', ['amount']);
    expect(message).toContain('**Tally Deal Desk needs a few more details.** Missing or unclear: amount.');
    expect(message).toContain('```text\ntemplate: physical');
  });

  test('the model gets the same plain words in its system prompt', () => {
    expect(systemPrompt('deal-desk')).toContain(plainWordsForPrompt());
    expect(plainWordsForPrompt()).toContain('- `core_only`: the seller keeps the core and the buyer gets the holdback back');
  });

  test('Mediator and Trust Check: plain words on the showcase contracts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coworker-answers-'));
    const path = join(directory, 'agent.sqlite');
    const now = Date.UTC(2026, 9, 7, 6, 0, 0);
    try {
      await seedShowcase(path, now);
      const store = AgentStore.open(path);
      try {
        const tools = new CoworkerTools(store, {config: loadContractConfig(envOf([], KIT_ENV)), now: () => now});
        const tier3 = ok(tools.contractSummaries({disputesOnly: true})).find((contract: ContractSummary) => contract.milestones[0]?.state === 'tier_3_mediation');
        expect(tier3).toBeDefined();
        const mediation = answerText(answerFillIn('mediator', `contract: ${tier3?.id}\nmilestone: 0`, tools));
        expectReadable(mediation);
        expect(mediation).toContain('**Draft for the human mediator.** This is not a ruling');
        expect(mediation).toContain('### What each ruling would do');
        expect(mediation).toContain('- **If the seller wins:**');

        const profile = answerText(answerFillIn('trust-check', `company: ${SHOWCASE_PARTIES.highland.id}`, tools));
        expectReadable(profile);
        expect(profile.startsWith(`## ${SHOWCASE_PARTIES.highland.displayName}\n`)).toBe(true);
        expect(profile).toContain('These are facts from Tally records, not a verdict or a credit rating.');
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
