# Tally Coworkers

Three Sokosumi Coworkers sell Tally's contract features as paid Tasks.
They share one rule: **every number comes from Tally's code.**
The language model reads the request, calls tools, and explains the results. It never calculates.

| Coworker | Job | Instructions |
| --- | --- | --- |
| Tally Deal Desk | Turns a plain-English deal into a ready-to-sign escrow contract draft | [deal-desk.md](deal-desk.md) |
| Tally Mediator | Drafts a Tier 3 ruling for a human mediator to sign | [mediator.md](mediator.md) |
| Tally Trust Check | Explains a company's Tally record before a deal | [trust-check.md](trust-check.md) |

Every Coworker loads [shared-rules.md](shared-rules.md) first. The shared rules win over a Coworker file.

## Tools

The tools are in [`../coworker-tools.ts`](../coworker-tools.ts). Each tool calls the contract engine or the reliability policies. None has its own business rules.

| Tool | Coworker | Engine code behind the numbers |
| --- | --- | --- |
| `listTemplates()` | Deal Desk | `TemplateRegistry`, the window overrides from `loadContractConfig` |
| `draftContract(input)` | Deal Desk | `ContractLifecycle.createContract` (all validation) in an in-memory sandbox, `computeDeadlines`, `validateDeadlines`, `inspectionCutoff`, `disputeBudgetMs`, `trancheLayout` (through the engine), `decisionsFor`, `allowedOutcomes`, `decisionsForOutcome`, `disputeFee` |
| `disputeCase(contractId, milestone)` | Mediator | The stored contract, evidence, and audit log |
| `rulingOptions(contractId, milestone)` | Mediator | `ContractLifecycle.submitMediatorRuling` on a sandbox copy for each winner, then `milestoneOutcome` |
| `rulingSigningPayload(...)` | Mediator | `mediatorRulingBytes`. The human mediator signs these bytes |
| `findEntities(query)` | Trust Check | The entity table |
| `reliabilityProfile(entityId)` | Trust Check | `ScoringPolicy.scoreView`, stored terms decisions, stored outcomes, `settlementRecord` |

Rules the tools follow:

- Amounts are parsed and formatted exactly with `bigint`. No floating point touches money.
- Every amount, time, and duration carries its exact value (`atomic`, `ms`) and a display form. The instructions tell the model to copy the display form.
- Simulations run the real engine on an in-memory copy in paper mode with throwaway keys. They never write to the shared store or send a transaction.
- An engine rule violation returns `{ok: false, error: {code, message}}`. The instructions map each code to a question for the user.

`coworker-tools.test.ts` checks each tool against the engine. The Mediator test signs the tool's payload with the mediator key and checks that the real engine accepts it and does what the simulation said.

## Without a language model

The tools are deterministic. A structured Task can be answered with no model at all.
The model only turns free text into tool inputs and writes the explanation.
A model outage therefore stops explanations, not the numbers.

## Preprod registrations

| Coworker | Sokosumi Coworker id | Masumi agent (preprod) |
| --- | --- | --- |
| Tally Deal Desk | `01a11354-0a28-745c-8424-c0f06b1331cb` | registered, tx `e72ca040…2352` |
| Tally Mediator | `01a11354-2a34-71af-917c-8114f24fc1cb` | registered, tx `e72ca040…2352` |
| Tally Trust Check | `01a11354-467b-7049-826a-0e7087f78a59` | registered, tx `e72ca040…2352` |

Vendor: Tally (`01a11310-03a7-760a-a31a-f6ba1872959c`).
All three Coworkers have access to the TOKEN2049 Origins workspace.
Read [the preprod server](../../../deploy/preprod/README.md) to rebuild the payment service and the registrations.
Each Masumi agent uses `apiBaseUrl` `https://13-210-42-0.sslip.io/<deal-desk|mediator|trust-check>`.

## The Task worker

[`../coworker-worker.ts`](../coworker-worker.ts) runs the three Coworkers on Sokosumi.
For each Task assigned to a Coworker, it does these steps in order:

1. Read the Task with the Coworker's own key (`coworker_...`). This works in personal and organization workspaces.
2. Without a model: compute the whole answer first. If the request is unreadable or the engine rejects it, set `INPUT_REQUIRED` with the fill-in format. Nobody pays for that.
3. Set `RUNNING`. Ask the Masumi payment service for a payment request ([`../mps-seller.ts`](../mps-seller.ts)). Post it to the Task as a `masumiPayment` event. Sokosumi locks the buyer's test USDM in the escrow.
4. Wait for `FundsLocked` in a confirmed transaction. With a model, run the model only now.
5. Submit the result hash in the form that Sokosumi checks, then complete the Task with the answer.
6. Follow the escrow until the payment service collects for the seller. Record the collection transaction.

The journal (`COWORKER_STATE_DIR`, one file per Task) records each stage before every external write.
After a crash, a write whose outcome is unknown is not sent again. The Task stops at stage `inspect` for a person.
If the funds do not lock before the result deadline, or the model fails, the Task is marked `FAILED` and no result is submitted, so the escrow refunds the buyer.

### Choose the model

The model is one setting, `COWORKER_MODEL_PROVIDER`, in [`tally-coworkers.service`](../../../deploy/preprod/tally-coworkers.service):

| Value | Model | Secret file in `~/tally-secrets` |
| --- | --- | --- |
| `none` | No model. The Coworkers answer the fill-in format | none |
| `gemini` | Google Gemini (`COWORKER_GEMINI_MODEL`) | `gemini_api_key` |
| `bedrock` | Claude on Amazon Bedrock (`COWORKER_BEDROCK_MODEL_ID`, `COWORKER_BEDROCK_REGION`) with a Bedrock API key | `bedrock_api_key` |

To switch, edit the line, then run `sudo systemctl daemon-reload && sudo systemctl restart tally-coworkers`.
If a model call fails, a readable fill-in request still gets the fill-in answer.

### Fill-in format

Deal Desk:

```text
template: physical
item: Lot 1, 1,200 kg green arabica, Grade A
amount: 4000
remedy: partial 70
description: Green arabica, washed
quantity: 1200
unit: kg
```

Mediator: `contract: <contract id>` and `milestone: 0`. Trust Check: `company: <name or Tally id>`.

## Not done yet

1. **A first live paid Task.** The worker is tested against fake Sokosumi and fake MPS services only.
2. **The Mediator never signs.** The platform mediator key stays with a person. Wiring the signed ruling back into Tally is a manual step.
3. **Score-based contract terms.** Tally does not set escrow terms from scores yet. Trust Check says so.
4. **Bedrock with the server role.** The Bedrock provider uses a Bedrock API key. Signing with the instance role (SigV4) is not built.
