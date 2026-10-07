/**
 * @fileoverview Settlement anchors: proof on Cardano that Tally's settlement
 * records, the records the reliability scores come from, were not edited or
 * deleted, without publishing them.
 *
 * - Record fingerprint: SHA-256 of the canonical JSON (RFC 8785) of a final
 *   milestone publication (outcome successful, failed, cancelled, or
 *   unresolved).
 * - Company chain: each participant of the record gets an entry
 *   {v, entity, seq, prev, record, publication}. Its SHA-256 is the entry
 *   fingerprint. `seq` counts from 1 per company and `prev` is the previous
 *   entry fingerprint (64 zeros for the first), so an edited or deleted deal
 *   breaks the chain.
 * - On the chain: only entry fingerprints, as a CIP-20 message (metadata
 *   label 674) in a batch transaction from the platform anchor wallet. No
 *   names, amounts, or terms.
 *
 * Every chain write follows the payment rules:
 * - The signed transaction and its hash are saved before it is sent.
 * - A send with an unknown result is never replaced by a new transaction.
 *   The worker reads the chain. A batch is confirmed only when its
 *   transaction has MIN_CONFIRMATIONS and its metadata lists every entry. It
 *   expires only when the chain tip has passed its validity interval and the
 *   transaction is not on the chain. Only then can its entries join a new
 *   batch. Sending the same signed transaction again is safe: the chain
 *   includes one transaction id at most once.
 * - One batch at a time, so two batches never spend the same inputs.
 * - Nothing is sent unless the worker runs with ANCHOR_SUBMIT=on.
 */

import {createHash, randomUUID} from 'node:crypto';
import type {AgentStore, AnchorBatchRow, AnchoredEntryView, AnchorEntryRow} from '../../packages/db/src/index';
import {canonicalize} from '../../packages/reliability/src/contract-lifecycle/canonical-json';

export const ANCHOR_VERSION = 1;
export const ZERO_HASH = '0'.repeat(64);
/** The first line of every anchor message. */
export const ANCHOR_MESSAGE_HEADER = 'Tally settlement anchors v1';
/** CIP-20 transaction message label. Explorers show these messages. */
export const ANCHOR_METADATA_LABEL = 674;
export const MAX_BATCH_ENTRIES = 60;
export const MIN_CONFIRMATIONS = 2;
/** About 30 minutes of preprod slots (one slot per second). */
export const VALIDITY_SLOTS = 1800;
/** Slots past the validity interval before a missing transaction counts as expired. */
export const EXPIRY_MARGIN_SLOTS = 120;
export const RESEND_AFTER_MS = 5 * 60_000;
export const EXPLORER_TX_URL = 'https://preprod.cardanoscan.io/transaction/';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The fingerprint of one settlement record (a parsed publication). */
export function recordHash(publication: unknown): string {
  return sha256(canonicalize(publication));
}

export interface EntryFields {
  entityId: string;
  seq: number;
  prevHash: string;
  recordHash: string;
  publicationId: string;
}

/** The fingerprint of one company chain entry. This is what goes on the chain. */
export function entryHash(entry: EntryFields): string {
  return sha256(canonicalize({
    v: ANCHOR_VERSION, entity: entry.entityId, seq: entry.seq, prev: entry.prevHash, record: entry.recordHash, publication: entry.publicationId,
  }));
}

interface PublicationShape {
  id: string;
  transaction?: {participants?: Array<{entityId?: unknown}>};
  outcome?: {state?: unknown};
}

/** The companies in a record, sorted, each once. */
export function participantsOf(publication: PublicationShape): string[] {
  const ids = (publication.transaction?.participants ?? []).map((item) => item.entityId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort();
}

export interface ChainCheck {
  intact: boolean;
  problems: string[];
}

/** Checks a company chain against the stored records: numbering, links, and both fingerprints. */
export function verifyCompanyChain(entries: AnchorEntryRow[], publicationJson: (id: string) => string|null): ChainCheck {
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.seq !== index + 1) problems.push(`entry ${index + 1} has number ${entry.seq}: an entry is missing`);
    const expectedPrev = index === 0 ? ZERO_HASH : entries[index - 1]?.entryHash;
    if (entry.prevHash !== expectedPrev) problems.push(`entry ${entry.seq} does not link to the entry before it`);
    if (entryHash(entry) !== entry.entryHash) problems.push(`entry ${entry.seq} does not match its fingerprint`);
    const json = publicationJson(entry.publicationId);
    if (json === null) problems.push(`entry ${entry.seq}: the settlement record is missing`);
    else if (recordHash(JSON.parse(json)) !== entry.recordHash) problems.push(`entry ${entry.seq}: the settlement record was changed after it was fingerprinted`);
  });
  return {intact: problems.length === 0, problems};
}

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

export interface ChainTip {
  slot: number;
  height: number;
}

export interface AnchorChain {
  tip(): Promise<ChainTip>;
  /** The transaction's block, or null when the chain does not have it. */
  transaction(txHash: string): Promise<{blockHeight: number; blockTime: number}|null>;
  /** The CIP-20 message lines of the transaction, or null when it has none. */
  anchorMessage(txHash: string): Promise<string[]|null>;
  /** Builds and signs a transaction that carries `message` and is valid until `invalidHereafter`. */
  build(message: string[], invalidHereafter: number): Promise<{txHash: string; cborHex: string}|{unfunded: true}>;
  /** Sends signed bytes. Returns the transaction id the node reports. */
  submit(cborHex: string): Promise<string>;
}

export interface AnchorWorkerDeps {
  store: AgentStore;
  chain: AnchorChain|null;
  /** False: fingerprints are recorded, and nothing is sent to the chain. */
  submit: boolean;
  now: () => number;
  log: (line: {[key: string]: unknown}) => void;
}

const sameLines = (left: string[], right: string[]) => left.length === right.length && left.every((line, index) => line === right[index]);

export class AnchorWorker {
  constructor(private readonly deps: AnchorWorkerDeps) {}

  /** Adds chain entries for every final record that has none. Returns how many entries it added. */
  collect(): number {
    const {store, now} = this.deps;
    let added = 0;
    for (const publication of store.listUnanchoredFinalPublications()) {
      const parsed = JSON.parse(publication.json) as PublicationShape;
      const companies = participantsOf(parsed);
      if (!companies.length) {
        this.deps.log({event: 'anchor_record_without_participants', publicationId: publication.id});
        continue;
      }
      const record = recordHash(parsed);
      const entries: AnchorEntryRow[] = companies.map((entityId) => {
        const last = store.lastAnchorEntry(entityId);
        const fields = {entityId, seq: (last?.seq ?? 0) + 1, prevHash: last?.entryHash ?? ZERO_HASH, recordHash: record, publicationId: publication.id};
        return {...fields, entryHash: entryHash(fields), contractId: publication.contractId, milestoneId: publication.milestoneId, batchId: null, createdAt: now()};
      });
      store.insertAnchorEntries(entries);
      added += entries.length;
    }
    if (added) this.deps.log({event: 'anchor_entries_added', count: added});
    return added;
  }

  async runOnce(): Promise<void> {
    this.collect();
    const {store, chain} = this.deps;
    if (!chain) return;
    const open = store.getOpenAnchorBatch();
    if (open) {
      await this.follow(open);
      return;
    }
    if (!this.deps.submit) return;
    await this.startBatch();
  }

  /** Reads the chain for the open batch: confirm it, let it expire, or send the same bytes again. */
  private async follow(batch: AnchorBatchRow): Promise<void> {
    const {store, chain, now, log} = this.deps;
    if (!chain) return;
    const found = await chain.transaction(batch.txHash);
    if (found) {
      const tip = await chain.tip();
      const confirmations = tip.height - found.blockHeight + 1;
      if (confirmations < MIN_CONFIRMATIONS) {
        log({event: 'anchor_batch_confirming', batchId: batch.id, txHash: batch.txHash, confirmations});
        return;
      }
      const message = await chain.anchorMessage(batch.txHash);
      if (!message || !sameLines(message, [ANCHOR_MESSAGE_HEADER, ...batch.entryHashes])) {
        store.markAnchorBatchSubmitted(batch.id, now(), 'on the chain, but its message does not match the saved batch: inspect it');
        log({event: 'anchor_batch_mismatch', batchId: batch.id, txHash: batch.txHash});
        return;
      }
      store.markAnchorBatchConfirmed(batch.id, {at: now(), blockHeight: found.blockHeight, blockTime: found.blockTime});
      log({event: 'anchor_batch_confirmed', batchId: batch.id, txHash: batch.txHash, entries: batch.entryHashes.length, blockHeight: found.blockHeight});
      return;
    }
    const tip = await chain.tip();
    if (tip.slot > batch.invalidHereafter + EXPIRY_MARGIN_SLOTS) {
      store.markAnchorBatchExpired(batch.id, now(), 'the validity interval passed and the transaction is not on the chain');
      log({event: 'anchor_batch_expired', batchId: batch.id, txHash: batch.txHash});
      return;
    }
    if (this.deps.submit && (batch.status === 'prepared' || now() - (batch.submittedAt ?? 0) >= RESEND_AFTER_MS)) await this.send(batch);
  }

  private async startBatch(): Promise<void> {
    const {store, chain, now, log} = this.deps;
    if (!chain) return;
    const entries = store.listUnbatchedAnchorEntries(MAX_BATCH_ENTRIES);
    if (!entries.length) return;
    const tip = await chain.tip();
    const invalidHereafter = tip.slot + VALIDITY_SLOTS;
    const hashes = entries.map((entry) => entry.entryHash);
    const built = await chain.build([ANCHOR_MESSAGE_HEADER, ...hashes], invalidHereafter);
    if ('unfunded' in built) {
      log({event: 'anchor_wallet_unfunded', waiting: entries.length});
      return;
    }
    const id = randomUUID();
    // Saved before it is sent. A crash after this line resumes in follow().
    store.createAnchorBatch({id, txHash: built.txHash, txCbor: built.cborHex, invalidHereafter, entryHashes: hashes, createdAt: now()});
    log({event: 'anchor_batch_prepared', batchId: id, txHash: built.txHash, entries: hashes.length, invalidHereafter});
    await this.send(store.getAnchorBatch(id) as AnchorBatchRow);
  }

  /** Sends the saved bytes. Whatever the node answers, only the chain decides the batch's fate. */
  private async send(batch: AnchorBatchRow): Promise<void> {
    const {store, chain, now, log} = this.deps;
    if (!chain) return;
    let note: string|null = null;
    try {
      const reported = await chain.submit(batch.txCbor);
      if (reported !== batch.txHash) note = `the node reported transaction ${reported}`;
    } catch (error) {
      note = `send failed: ${(error as Error).message}`;
    }
    store.markAnchorBatchSubmitted(batch.id, now(), note);
    log({event: 'anchor_batch_sent', batchId: batch.id, txHash: batch.txHash, note});
  }
}

// ---------------------------------------------------------------------------
// Read views for the API and the website
// ---------------------------------------------------------------------------

export interface AnchorView {
  status: 'waiting'|'sending'|'confirmed';
  txHashes: string[];
  explorerUrls: string[];
  blockHeight: number|null;
  anchoredAt: string|null;
}

function anchorOf(entries: AnchoredEntryView[]): AnchorView {
  const confirmed = entries.every((entry) => entry.batchStatus === 'confirmed');
  const sending = entries.some((entry) => entry.batchStatus === 'prepared' || entry.batchStatus === 'submitted');
  // An expired batch releases its entries, so every batch still linked is sending or confirmed.
  const txHashes = [...new Set(entries.map((entry) => entry.txHash).filter((hash): hash is string => !!hash))];
  const times = entries.map((entry) => entry.blockTime).filter((time): time is number => time !== null);
  return {
    status: confirmed ? 'confirmed' : sending ? 'sending' : 'waiting',
    txHashes,
    explorerUrls: txHashes.map((hash) => `${EXPLORER_TX_URL}${hash}`),
    blockHeight: confirmed ? Math.max(...entries.map((entry) => entry.blockHeight ?? 0)) : null,
    anchoredAt: confirmed && times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
  };
}

/** Every fingerprinted record of a contract, with its anchor and a fresh check of the record. */
export function contractAnchors(store: AgentStore, contractId: string) {
  const byPublication = new Map<string, AnchoredEntryView[]>();
  for (const entry of store.listAnchorEntriesForContract(contractId)) {
    byPublication.set(entry.publicationId, [...(byPublication.get(entry.publicationId) ?? []), entry]);
  }
  return {
    contractId,
    records: [...byPublication.entries()].map(([publicationId, entries]) => {
      const json = store.getContractPublicationJson(publicationId);
      const parsed = json === null ? null : JSON.parse(json) as PublicationShape;
      const first = entries[0] as AnchoredEntryView;
      return {
        publicationId,
        milestoneId: first.milestoneId,
        outcome: typeof parsed?.outcome?.state === 'string' ? parsed.outcome.state : null,
        recordHash: first.recordHash,
        recordUnchanged: parsed !== null && recordHash(parsed) === first.recordHash,
        entries: entries.map((entry) => ({entityId: entry.entityId, seq: entry.seq, entryHash: entry.entryHash})),
        anchor: anchorOf(entries),
      };
    }),
  };
}

/** A company's chain: its entries, how many are on the chain, and a fresh check of every link. */
export function companyAnchors(store: AgentStore, entityId: string) {
  const entries = store.listAnchorEntriesForEntity(entityId);
  const check = verifyCompanyChain(entries, (id) => store.getContractPublicationJson(id));
  return {
    entityId,
    chain: {
      ...check,
      length: entries.length,
      anchored: entries.filter((entry) => entry.batchStatus === 'confirmed').length,
      head: entries.at(-1)?.entryHash ?? null,
    },
    entries: entries.map((entry) => ({
      seq: entry.seq, entryHash: entry.entryHash, recordHash: entry.recordHash, contractId: entry.contractId, milestoneId: entry.milestoneId,
      anchor: anchorOf([entry]),
    })),
  };
}
