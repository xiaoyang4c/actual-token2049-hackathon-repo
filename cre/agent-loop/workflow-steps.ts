import { json, ok, type HTTPSendRequester } from '@chainlink/cre-sdk'
import { z } from 'zod'
import {
	normalizeGammaMarkets,
	normalizeKalshiEvents,
	type GammaMarket,
	type Intent,
	type KalshiEventsResponse,
	type NormalizedMarket,
	type Policy,
	type Portfolio,
	type ScoreRequest,
	type Signal,
	type Venue,
} from '../../packages/core/src'
import type { Config } from './workflow-config'

export type AuditEvent = { type: string; detail: string }

// ─── HTTP helpers ───────────────────────────────────────────
// POSTs carry cacheSettings so that when every DON node runs the request,
// one node's response is reused and the side effect happens once.
const WRITE_CACHE = { store: true, maxAge: '60s' }

const encodeBody = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64')

const getJson = <T>(sender: HTTPSendRequester, url: string): T => {
	const resp = sender.sendRequest({ url, method: 'GET' }).result()
	if (!ok(resp)) throw new Error(`GET ${url} failed: ${resp.statusCode}`)
	return json(resp) as T
}

const postJson = <T>(
	sender: HTTPSendRequester,
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): { status: number; body: T } => {
	const multiHeaders: Record<string, { values: string[] }> = { 'Content-Type': { values: ['application/json'] } }
	for (const name of Object.keys(headers).sort()) multiHeaders[name] = { values: [headers[name]] }
	const resp = sender
		.sendRequest({ url, method: 'POST', body: encodeBody(body), multiHeaders, cacheSettings: WRITE_CACHE })
		.result()
	return { status: resp.statusCode, body: json(resp) as T }
}

// ─── Steps (each runs on every node, then reaches consensus) ─
export type AgentState = { policy: Policy; portfolio: Portfolio }

export const fetchState = (sender: HTTPSendRequester, config: Config): AgentState =>
	getJson<AgentState>(sender, `${config.controlApiUrl}/agent/state`)

// Venue readers normalize inside the node function so nodes agree on a small, typed value.
type VenueReader = (sender: HTTPSendRequester, url: string) => NormalizedMarket[]

// Fixed order keeps the merged market list identical across nodes.
export const VENUE_READERS: [Venue, VenueReader][] = [
	['polymarket', (sender, url) => normalizeGammaMarkets(getJson<GammaMarket[]>(sender, url))],
	['kalshi', (sender, url) => normalizeKalshiEvents(getJson<KalshiEventsResponse>(sender, url))],
]

const paymentRequirementSchema = z.object({
	scheme: z.string(),
	network: z.string(),
	maxAmountRequired: z.string(),
	asset: z.string(),
	payTo: z.string(),
	resource: z.string(),
	// Bind the payment receipt to the score request.
	inputHash: z.string().regex(/^[a-f0-9]{64}$/),
	description: z.string(),
	maxTimeoutSeconds: z.number().finite(),
})
type PaymentRequirement = z.infer<typeof paymentRequirementSchema>
export type Quote = { free: boolean; signals: Signal[]; requirement: PaymentRequirement }

const EMPTY_REQUIREMENT: PaymentRequirement = {
	scheme: '',
	network: '',
	maxAmountRequired: '0',
	asset: '',
	payTo: '',
	resource: '',
	inputHash: '',
	description: '',
	maxTimeoutSeconds: 0,
}

// x402 step 1: call without payment and read the 402 requirements.
export const requestQuote = (sender: HTTPSendRequester, config: Config, body: ScoreRequest): Quote => {
	const resp = postJson<{ signals?: Signal[]; accepts?: PaymentRequirement[] }>(sender, config.scoreUrl, body)
	if (resp.status === 200) return { free: true, signals: resp.body.signals ?? [], requirement: EMPTY_REQUIREMENT }
	const requirement = resp.body.accepts?.[0]
	if (resp.status !== 402 || !requirement) throw new Error(`score quote failed: ${resp.status}`)
	// Malformed fields must not cross CRE consensus as null or undefined.
	// The empty requirement takes the audited payment refusal path.
	const parsed = paymentRequirementSchema.safeParse(requirement)
	return { free: false, signals: [], requirement: parsed.success ? parsed.data : EMPTY_REQUIREMENT }
}

export type Payment = { receiptId: string; txHash: string; amount: number; xPayment: string }

// x402 step 2: the Cardano agent service pays (escrowed via Masumi) and returns the X-PAYMENT header.
export const pay = (sender: HTTPSendRequester, config: Config, idempotencyKey: string, requirement: PaymentRequirement): Payment => {
	const resp = postJson<{ receipt: { receiptId: string; txHash: string; amount: number }; xPayment: string; error?: string }>(
		sender,
		`${config.cardanoAgentUrl}/pay`,
		{ idempotencyKey, requirement },
	)
	if (resp.status !== 200) throw new Error(`payment failed: ${resp.status} ${resp.body.error ?? ''}`)
	const { receipt, xPayment } = resp.body
	return { receiptId: receipt.receiptId, txHash: receipt.txHash, amount: receipt.amount, xPayment }
}

// x402 step 3: retry the request with proof of payment.
export const fetchPaidScores = (sender: HTTPSendRequester, config: Config, body: ScoreRequest, xPayment: string): Signal[] => {
	const resp = postJson<{ signals: Signal[] }>(sender, config.scoreUrl, body, { 'X-PAYMENT': xPayment })
	if (resp.status !== 200) throw new Error(`paid score request failed: ${resp.status}`)
	return resp.body.signals
}

export type Fill = { idempotencyKey: string; status: string; mode: string; marketId: string; side: string; size: number; price: number; reason: string }

export const submitOrders = (
	sender: HTTPSendRequester,
	config: Config,
	cycleId: string,
	orders: { idempotencyKey: string; intent: Intent }[],
): Fill[] => {
	const resp = postJson<{ fills: Fill[] }>(sender, `${config.controlApiUrl}/orders`, { cycleId, orders })
	if (resp.status !== 200) throw new Error(`orders failed: ${resp.status}`)
	return resp.body.fills
}

export const writeAudit = (sender: HTTPSendRequester, config: Config, cycleId: string, events: AuditEvent[]): number => {
	const resp = postJson<{ ok: boolean }>(sender, `${config.controlApiUrl}/audit`, { cycleId, events })
	return resp.status
}
