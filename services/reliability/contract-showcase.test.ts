/**
 * @fileoverview The showcase seeds real engine states, and the read views
 * report them with future deadlines for the open steps.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {envOf, KIT_ENV} from './contract-kit';
import {loadContractConfig} from './contract-config';
import {seedShowcase, SHOWCASE_PARTIES} from './contract-showcase';
import {CoworkerTools, type ContractSummary, type ToolResult} from './coworker-tools';

function ok<T>(result: ToolResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.result;
}

describe('contract showcase', () => {
  test('seeds six contracts in distinct stages with future deadlines for open steps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'showcase-'));
    const path = join(directory, 'agent.sqlite');
    const now = Date.UTC(2026, 9, 7, 6, 0, 0);
    try {
      const seeded = await seedShowcase(path, now);
      expect(seeded.contracts.map((item) => item.state)).toEqual([
        'settled', 'in_inspection', 'funded', 'tier_1_negotiation', 'tier_3_mediation', 'settled',
      ]);
      await expect(seedShowcase(path, now)).rejects.toThrow(/already has the showcase parties/);

      const store = AgentStore.open(path);
      try {
        const tools = new CoworkerTools(store, {config: loadContractConfig(envOf([], KIT_ENV)), now: () => now});
        const all = ok(tools.contractSummaries());
        expect(all).toHaveLength(6);
        expect(all.every((contract) => contract.label === 'SIMULATED')).toBe(true);

        const byState = (state: string): ContractSummary['milestones'][number] =>
          all.flatMap((contract) => contract.milestones).find((item) => item.state === state)!;
        const open: Array<[string, ContractSummary['milestones'][number]['next']['actor']]> = [
          ['in_inspection', 'buyer'], ['funded', 'seller'], ['tier_1_negotiation', 'both'], ['tier_3_mediation', 'mediator'],
        ];
        for (const [state, actor] of open) {
          const item = byState(state);
          expect(item.next.actor).toBe(actor);
          expect(item.next.dueAt!.ms).toBeGreaterThan(now);
        }
        expect(byState('settled').next.actor).toBe('none');

        const disputes = ok(tools.contractSummaries({disputesOnly: true}));
        expect(disputes.flatMap((contract) => contract.milestones.map((item) => item.state)).sort()).toEqual(['tier_1_negotiation', 'tier_3_mediation']);
        expect(ok(tools.contractSummaries({partyId: SHOWCASE_PARTIES.kopi.id}))).toHaveLength(4);
        expect(all.find((contract) => contract.buyer.id === SHOWCASE_PARTIES.kopi.id)?.buyer.displayName).toBe('Kopi Origin Roasters');

        const mediation = disputes.find((contract) => contract.milestones.some((item) => item.state === 'tier_3_mediation'))!;
        const options = ok(tools.rulingOptions(mediation.id, 0));
        expect(options.options.map((option) => option.payout?.toSeller.display)).toEqual(['2,275 test USDM', '3,250 test USDM']);

        const profile = ok(tools.reliabilityProfile(SHOWCASE_PARTIES.highland.id)) as {contractSummary: {simulated: {milestones: number; disputesLost: number}}};
        expect(profile.contractSummary.simulated.milestones).toBe(4);
        expect(profile.contractSummary.simulated.disputesLost).toBe(1);
        // The funded lot is not due yet, so it is not a late delivery.
        expect((profile.contractSummary.simulated as {lateDeliveries?: number}).lateDeliveries).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
