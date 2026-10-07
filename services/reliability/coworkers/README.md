# Tally Coworkers

Three Coworkers give Tally's contract features to people and agents.
People chat with them on the Tally website, free. Other agents hire them as paid Tasks on Sokosumi, with Masumi escrow.
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
Each Masumi agent uses `apiBaseUrl` `https://13.210.42.0/<deal-desk|mediator|trust-check>`.

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
After a restart, the worker validates requests before payment.
The worker checks Core before it repeats a completion event.
An event feed outage does not stop Tasks already in the journal.
An uncertain payment request or payment event stops at stage `inspect` for a person.
Timeout responses, server errors, and malformed success responses can leave writes uncertain.
The clients follow the [HTTP status definitions](https://www.rfc-editor.org/rfc/rfc9110.html#section-15).
If the funds do not lock before the result deadline, or the model fails, the Task is marked `FAILED` and no result is submitted, so the escrow refunds the buyer.

### Choose the model

The model is one setting, `COWORKER_MODEL_PROVIDER`, in [`tally-coworkers.service`](../../../deploy/preprod/tally-coworkers.service):

| Value | Model | Secret file in `~/tally-secrets` |
| --- | --- | --- |
| `none` | No model. The Coworkers answer the fill-in format | none |
| `gemini` | Google Gemini. `COWORKER_GEMINI_MODEL` is a comma-separated list, tried in order | `gemini_api_key` |
| `bedrock` | Claude on Amazon Bedrock (`COWORKER_BEDROCK_MODEL_ID`, `COWORKER_BEDROCK_REGION`) with a Bedrock API key | `bedrock_api_key` |
| `openai-compatible` | Any [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create) API with function tools (`COWORKER_OPENAI_BASE_URL`, `COWORKER_OPENAI_MODEL`). `COWORKER_OPENAI_MODEL` is a comma-separated list, tried in order | `openai_compatible_api_key` |

To switch, edit the line, then run `sudo systemctl daemon-reload && sudo systemctl restart tally-coworkers`.

#### A free model with no payment card

The service file sets `openai-compatible` up for the [Mistral](https://docs.mistral.ai/deployment/ai-studio/tier) free Experiment plan.
That plan needs a phone number but no payment card.
It allows 1 request a second, 500,000 tokens a minute, and 1 billion tokens a month.
Mistral can use the requests for training on that plan.
Use paper data only.

1. Create an API key at <https://console.mistral.ai>.
2. On the server, run `tally-set-secret openai_compatible_api_key` and paste the key.
3. Copy `tally-coworkers.service` to `/etc/systemd/system`. It sets `COWORKER_MODEL_PROVIDER=openai-compatible`.
4. Run `sudo systemctl daemon-reload && sudo systemctl restart tally-coworkers`.
5. Check that the log line `worker_started` shows `"provider":"openai-compatible"`.

Preprod runs Mistral this way since 7 October 2026.

Read the workspace limits at <https://admin.mistral.ai/plateforme/limits>.
`COWORKER_OPENAI_MIN_INTERVAL_MS` is the shortest time between two requests. Set it from the requests-per-second limit.

One Deal Desk request holds about 7,500 tokens of instructions before the user's message.
In October 2026 the free plans of GitHub Models (8,000 input tokens a request) and Cerebras (8,192-token context) were too small for it.
The Groq free plan (12,000 tokens a minute and 100,000 a day for Llama 3.3 70B) allowed only a few answers a day.
If a model call fails, a readable fill-in request still gets the fill-in answer.

The Gemini free tier allows 20 requests a day for each model, and one answer takes 2 to 4 requests.
Rate limits and overloaded servers are retried up to 4 times.
A model whose daily quota is used up is skipped until it resets. A model still overloaded after 4 tries is skipped for 5 minutes.
The next model in the list answers. If that happens in the middle of an answer, the answer starts again on the next model.
While every model is out of quota or overloaded, the worker answers in the fill-in format and checks the request before payment, as with `none`.

### On the Tally website

The chat on the Tally website sends messages to the same Coworkers. Users do not need Sokosumi or a wallet.
The worker answers them when `COWORKER_ASK_PORT` is set, on `127.0.0.1` only. The website forwards two routes to it.
The chat is free: no Masumi payment, no Sokosumi Task, and nothing is stored. Every tool only reads, and a draft uses a sandbox.

- One chat serves all three Coworkers. A message with `coworker: "auto"` goes to the Coworker that its words point to. A message with no clear words stays with the Coworker that answered last.
- The browser sends the earlier messages with each new message (`history`). The server keeps no conversation. It reads at most 12 earlier messages and cuts each one to 6,000 characters.
- The model reads the earlier messages. Its prompt tells it to call the tool again for every number.
- Without the model, a follow-up can send only the missing fill-in fields. The worker adds the user's earlier messages to the same Coworker.

[`../coworker-ask.ts`](../coworker-ask.ts) keeps the website from using the model quota that paid Tasks need:

- A request in the fill-in format never uses the model.
- At most 10 website answers a day use the model (`COWORKER_ASK_MODEL_PER_DAY`). After that, a plain-English request gets the fill-in format.
- One visitor gets at most 5 of those model answers a day (`COWORKER_ASK_MODEL_PER_VISITOR`).
- The preprod service file raises these limits to 100 and 20 for Mistral.
- Each visitor can send 20 messages every 10 minutes.
- One answer runs at a time, and at most 5 wait.
- A model answer gets 2 minutes. After that, the request gets the fill-in format, and the next answer starts.
  The chat page stops waiting for an answer that runs for more than 4 minutes.
- An answer stays readable for 30 minutes. The worker keeps jobs in memory, so a restart forgets them.

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

`item` and `amount` are milestone 1. Add a `milestone: <title> | <amount>` line only for each further lot.
A milestone line that repeats the item gets a question back, not a second lot.

Mediator: `contract: <contract id>` and `milestone: 0`. Trust Check: `company: <name or Tally id>`.

## Not done yet

1. **The Mediator never signs.** The platform mediator key stays with a person. Wiring the signed ruling back into Tally is a manual step.
2. **Score-based contract terms.** Tally does not set escrow terms from scores yet. Trust Check says so.
3. **Bedrock with the server role.** The Bedrock provider uses a Bedrock API key. Signing with the instance role (SigV4) is not built.
