# Settlement anchors

Tally keeps deal records private and proves on Cardano that they were not edited or deleted.
Payments already run on the chain through the Masumi escrow. Anchors cover the records that the reliability scores come from.

## What lives where

| Where | What |
| --- | --- |
| Cardano preprod (public) | Escrow funding, release, and refund (Masumi). The fingerprints of settled records (anchors) |
| Tally database (private) | Company names, contract terms, evidence, disputes, rulings, KYC, scores, and the link from each fingerprint to its record |

An anchor transaction carries only fingerprints. It holds no names, amounts, or terms.

## How a record is fingerprinted

1. A milestone ends with a final outcome: successful, failed, cancelled, or unresolved. The contract engine stores that settlement record (a contract publication). The scores are computed from these records.
2. The record fingerprint is the SHA-256 of its canonical JSON ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)).
3. Each company in the record gets an entry in its own chain: `{v, entity, seq, prev, record, publication}`. `seq` counts 1, 2, 3 for that company. `prev` is the fingerprint of the company's previous entry (64 zeros for the first). The SHA-256 of the canonical entry is the entry fingerprint.
4. The anchor worker posts entry fingerprints in a batch transaction, as a CIP-20 message under metadata label 674. The first line is `Tally settlement anchors v1`. Cardanoscan shows the message on the transaction page.

Code: [`anchors.ts`](../services/reliability/anchors.ts), [`anchor-chain.ts`](../services/reliability/anchor-chain.ts), [`anchor-records.ts`](../packages/db/src/anchor-records.ts), migration `015_reliability_anchors.sql`.

## How someone checks a record

A company can share its records with a lender or a new counterparty. The lender:

1. Hashes each record (canonical JSON, SHA-256) and compares it with the record fingerprint in the entry.
2. Recomputes each entry fingerprint and checks that `seq` runs 1, 2, 3 with no gap and that each `prev` is the fingerprint of the entry before it. An edited record changes its fingerprint. A deleted record leaves a gap.
3. Opens the anchor transaction on a Cardano explorer and finds each entry fingerprint in its message. That proves the entry existed at that block time.

The website shows the same checks: each settled milestone has its anchor status and a Cardanoscan link, and each company shows its chain and whether it is intact.

## Safety rules

Anchors write to the chain, so they follow the payment rules.

- The signed transaction and its id are saved before it is sent.
- A send with an unknown result is never replaced by a new transaction. The worker reads the chain.
- A batch is confirmed only when its transaction has 2 confirmations and its message lists exactly the saved fingerprints.
- A batch expires only when the chain has passed its validity interval (about 30 minutes) and the transaction is not on the chain. Only then do its entries join a new batch.
- Sending the same signed transaction again is safe. The chain includes one transaction id at most once.
- One batch at a time, so two batches never spend the same wallet outputs.
- Nothing is sent unless the worker runs with `ANCHOR_SUBMIT=on`.
- With submission off, the worker still checks existing batches for confirmation or expiry.
- Each send starts a new five-minute wait before the worker can resend the same transaction.

## Limits

- A company can still withhold its newest records from a lender. The chain proves that the records it shows are complete up to the last entry it shows. Tally can confirm the current chain length on request.
- The anchor wallet is a platform key on the server. It holds only test ADA for fees, never customer money.
- Paper (SIMULATED) records are anchored as they are. Each record says it is simulated.
- Preprod only. Mainnet is out of scope.

## Operations

On the preprod server:

```sh
bun run anchors:wallet     # creates ~/tally-secrets/anchor_wallet_skey if missing; prints the address
bun run anchors:status     # entries, batches, and the wallet balance
```

Fund the printed address with a few test ADA from <https://dispenser.masumi.network>. A batch costs about 0.2 test ADA.
[`tally-anchors.service`](../deploy/preprod/tally-anchors.service) runs the worker. It starts with `ANCHOR_SUBMIT=off`: it records fingerprints and sends nothing.
Set `ANCHOR_SUBMIT=on` only after the team approves the first write.
