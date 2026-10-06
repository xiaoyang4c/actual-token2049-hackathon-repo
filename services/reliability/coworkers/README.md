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

## Not done yet

1. **The Task worker.** It takes a Sokosumi Task, requests payment through the Masumi payment service, waits until the funds are locked, runs the model with these instructions and tools, submits the result, and completes the Task. It follows the reference Coworker in `masumi-network/demo-agent-token2049`.
2. **Model access.** The planned model is Claude on Amazon Bedrock. Bedrock access is on hold for the hackathon account. The worker takes the model as a setting, so another provider can replace it.
3. **The Mediator never signs.** The platform mediator key stays with a person. Wiring the signed ruling back into Tally is a manual step.
4. **Score-based contract terms.** Tally does not set escrow terms from scores yet. Trust Check says so.
