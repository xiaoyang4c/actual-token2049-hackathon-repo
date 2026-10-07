/**
 * @fileoverview Live deposit watcher. It reads the transactions that pay the
 * Tally deposit address on Cardano preprod and credits each one to the
 * account that sent it.
 *
 * Attribution: every spent input must belong to one account's proven
 * wallet. A stake key proof covers every address with that stake key. A
 * payment key proof covers addresses with that payment key. A transaction
 * with inputs from no account, or from two accounts, stays unattributed for
 * an operator. A transaction that spends from the deposit address is Tally's
 * own transfer and is not a deposit.
 *
 * A deposit is confirmed after `confirmations` blocks. A pending deposit that
 * leaves the chain is marked rolled back. The watcher signs nothing.
 */

import type {AgentStore, LiveDepositRow, LiveDepositStatus} from '../../packages/db/src/index';
import {addressKeyHashes, type DepositChain} from './deposit-chain';

/** The newest transactions that each pass reads. */
const SCAN_COUNT = 100;

export interface DepositWatcherOptions {
  store: AgentStore;
  chain: DepositChain;
  depositAddress: string;
  confirmations: number;
  now: () => number;
  log: (line: {[key: string]: unknown}) => void;
}

export interface PassResult {
  seen: number;
  confirmed: number;
  pending: number;
  unattributed: number;
  rolledBack: number;
}

const FINAL: ReadonlySet<LiveDepositStatus> = new Set(['confirmed', 'rolled_back']);

export class DepositWatcher {
  constructor(private readonly options: DepositWatcherOptions) {}

  /** Who owns each proven credential. */
  private owners(): {stake: Map<string, string>; payment: Map<string, string>} {
    const stake = new Map<string, string>();
    const payment = new Map<string, string>();
    for (const proof of this.options.store.listAllWalletProofs()) {
      (proof.credentialKind === 'stake' ? stake : payment).set(proof.credentialHash, proof.entityId);
    }
    return {stake, payment};
  }

  /** One pass over the newest transactions and every open deposit. */
  async runOnce(): Promise<PassResult> {
    const {store, chain, depositAddress, confirmations, now, log} = this.options;
    const result: PassResult = {seen: 0, confirmed: 0, pending: 0, unattributed: 0, rolledBack: 0};
    const tip = await chain.tip();
    const recent = await chain.addressTransactions(depositAddress, SCAN_COUNT);
    const owners = this.owners();
    // Pending deposits that fell out of the scan window are checked too.
    const open = store.listLiveDeposits({status: 'pending', limit: 500}).map((row) => row.txHash)
      .filter((hash) => !recent.some((tx) => tx.txHash === hash));
    const blocks = new Map(recent.map((tx) => [tx.txHash, tx]));
    for (const txHash of [...[...recent].reverse().map((tx) => tx.txHash), ...new Set(open)]) {
      const stored = store.listLiveDepositsForTx(txHash);
      if (stored.length && stored.every((row) => FINAL.has(row.status))) continue;
      const utxos = await chain.transactionUtxos(txHash);
      const block = blocks.get(txHash) ?? (utxos ? await chain.transactionBlock(txHash) : null);
      if (!utxos || !block) {
        for (const row of stored) store.upsertLiveDeposit({...row, status: 'rolled_back', note: 'the transaction left the chain'});
        if (stored.length) {
          result.rolledBack++;
          log({event: 'deposit_rolled_back', txHash});
        }
        continue;
      }
      if (utxos.inputs.some((input) => input.address === depositAddress)) continue;
      const paid = utxos.outputs.filter((output) => output.address === depositAddress);
      if (!paid.length) continue;
      const entities = new Set(utxos.inputs.map((input) => {
        const keys = addressKeyHashes(input.address);
        return (keys.stake && owners.stake.get(keys.stake)) || (keys.payment && owners.payment.get(keys.payment)) || null;
      }));
      const entityId = entities.size === 1 ? [...entities][0] ?? null : null;
      const depth = tip.height - block.blockHeight + 1;
      const status: LiveDepositStatus = !entityId ? 'unattributed' : depth >= confirmations ? 'confirmed' : 'pending';
      const at = now();
      for (const output of paid) {
        for (const amount of output.amounts) {
          if (BigInt(amount.quantity) <= 0n) continue;
          const previous = stored.find((row) => row.outputIndex === output.index && row.unit === amount.unit);
          const row: LiveDepositRow = {
            txHash, outputIndex: output.index, unit: amount.unit, quantity: amount.quantity, depositAddress, entityId, status,
            blockHeight: block.blockHeight, blockTime: block.blockTime,
            firstSeenAt: previous?.firstSeenAt ?? at, confirmedAt: status === 'confirmed' ? previous?.confirmedAt ?? at : null,
            note: entityId ? null : entities.size > 1 ? 'inputs come from more than one account' : 'no input comes from a proven wallet',
          };
          store.upsertLiveDeposit(row);
        }
      }
      result.seen++;
      if (status === 'confirmed') result.confirmed++;
      else if (status === 'pending') result.pending++;
      else result.unattributed++;
      if (!stored.length || stored[0]?.status !== status) log({event: 'deposit_seen', txHash, status, entityId, depth});
    }
    return result;
  }
}
