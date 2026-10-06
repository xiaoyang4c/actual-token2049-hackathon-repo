import { consensusIdenticalAggregation, cre, type Runtime } from '@chainlink/cre-sdk'
import {
	checkHalt,
	edgeVsSignal,
	eligibleEdgeMarkets,
	gateIntents,
	type NormalizedMarket,
	type PolicyDecision,
	type ScoreRequest,
	type Signal,
} from '../../packages/core/src'
import type { Config } from './workflow-config'
import {
	fetchPaidScores,
	fetchState,
	pay,
	requestQuote,
	submitOrders,
	VENUE_READERS,
	writeAudit,
	type AgentState,
	type AuditEvent,
	type Fill,
	type Payment,
	type Quote,
} from './workflow-steps'

export { configSchema, type Config } from './workflow-config'

// ─── Cycle ──────────────────────────────────────────────────
export const onCron = (runtime: Runtime<Config>): string => {
	const config = runtime.config
	const http = new cre.capabilities.HTTPClient()
	const cycleId = `cycle-${runtime.now().toISOString()}`
	const events: AuditEvent[] = []
	const record = (type: string, detail: string) => {
		events.push({ type, detail })
		runtime.log(`[${type}] ${detail}`)
	}
	const finish = (summary: string) => {
		record('cycle_end', summary)
		http.sendRequest(runtime, writeAudit, consensusIdenticalAggregation<number>())(config, cycleId, events).result()
		return summary
	}

	record('cycle_start', cycleId)

	// 1. Policy and portfolio from the control API.
	const state = http.sendRequest(runtime, fetchState, consensusIdenticalAggregation<AgentState>())(config).result()
	const { policy, portfolio } = state
	record('state', `cash ${portfolio.cash.toFixed(2)}, equity ${portfolio.equity.toFixed(2)}, positions ${portfolio.positions.length}`)

	// 2. Hard stops come first: a halted agent buys no data and places no orders.
	const halt = checkHalt(policy, portfolio)
	if (halt.halted) {
		record('halted', halt.reasons.join('; '))
		return finish('halted: no data purchased, no orders placed')
	}

	// 3. Venue reads, only for venues the policy enables. One venue failing
	// doesn't stop the cycle; the others still trade.
	const markets: NormalizedMarket[] = []
	for (const [venue, reader] of VENUE_READERS) {
		const url = config.venueUrls[venue]
		if (!url || !policy.venues_enabled.includes(venue)) continue
		try {
			const read = http.sendRequest(runtime, reader, consensusIdenticalAggregation<NormalizedMarket[]>())(url).result()
			markets.push(...read)
			record('markets', `${venue}: ${read.length} binary markets`)
		} catch (err) {
			record('venue_error', `${venue}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	if (markets.length === 0) return finish('no markets')
	const eligible = eligibleEdgeMarkets(markets, policy, portfolio, config.strategy)
	record('eligible_markets', `${eligible.length} of ${markets.length} markets can pass strategy and policy`)
	if (eligible.length === 0) return finish('no eligible markets: no data purchased, no orders placed')

	// 4. Paid signal over x402: quote, pay on Cardano, then fetch.
	const scoreBody: ScoreRequest = { markets: eligible.map((m) => ({ venue: m.venue, marketId: m.marketId, yesPrice: m.yesPrice })) }
	const quote = http.sendRequest(runtime, requestQuote, consensusIdenticalAggregation<Quote>())(config, scoreBody).result()

	let signals = quote.signals
	if (!quote.free) {
		const req = quote.requirement
		const amount = typeof req.maxAmountRequired === 'string' && /^\d+$/.test(req.maxAmountRequired)
			? Number(req.maxAmountRequired) : NaN
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			record('payment_refused', 'invalid payment amount: expected positive integer lovelace')
			return finish('invalid data payment: no orders placed')
		}
		if (!Number.isSafeInteger(config.maxDataPaymentLovelace) || config.maxDataPaymentLovelace < 0) {
			record('payment_refused', 'invalid data payment cap')
			return finish('invalid data payment cap: no orders placed')
		}
		record('x402_quote', `${amount} ${req.asset} on ${req.network} to ${req.payTo} for ${req.resource}`)
		if (amount > config.maxDataPaymentLovelace) {
			record('payment_refused', `${amount} > cap ${config.maxDataPaymentLovelace}`)
			return finish('data too expensive: no orders placed')
		}

		const payment = http
			.sendRequest(runtime, pay, consensusIdenticalAggregation<Payment>())(config, `${cycleId}:score`, req)
			.result()
		record('cardano_payment', `receipt ${payment.receiptId}, tx ${payment.txHash.slice(0, 16)}… (escrowed)`)

		signals = http
			.sendRequest(runtime, fetchPaidScores, consensusIdenticalAggregation<Signal[]>())(config, scoreBody, payment.xPayment)
			.result()
	}
	record('signals', `${signals.length} fair-value scores received`)

	// 5. Strategy proposes, policy decides.
	// Rank all proposals so blocked orders do not consume the execution limit.
	const intents = edgeVsSignal.evaluate({ markets: eligible, signals, portfolio }, { ...config.strategy, maxIntents: eligible.length })
	const decisions = gateIntents(intents, eligible, policy, portfolio, config.strategy.maxIntents)
	for (const d of decisions) record(d.approved ? 'policy_approved' : 'policy_blocked', describeDecision(d, markets))

	const approved = decisions.filter((d) => d.approved)
	if (approved.length === 0) return finish(`${intents.length} proposed, 0 approved`)

	// 6. Execute. Keys are stable per cycle so retries never double-fill.
	const orders = approved.map((d, i) => ({ idempotencyKey: `${cycleId}:order:${i}`, intent: d.intent }))
	const fills = http
		.sendRequest(runtime, submitOrders, consensusIdenticalAggregation<Fill[]>())(config, cycleId, orders)
		.result()
	for (const f of fills) {
		record(`fill_${f.status}`, `[${f.mode.toUpperCase()}] ${f.side} ${f.size} @ ${f.price} on ${f.marketId} (${f.reason})`)
	}

	const filled = fills.filter((f) => f.status === 'filled')
	const modes = [...new Set(filled.map((f) => f.mode))].sort()
	const execution = modes.length === 0 ? 'no fills' : modes.length === 1 ? modes[0] : `mixed: ${modes.join('/')}`
	return finish(`${intents.length} proposed, ${approved.length} approved, ${filled.length} filled (${execution})`)
}

const describeDecision = (d: PolicyDecision, markets: NormalizedMarket[]): string => {
	const m = markets.find((x) => x.venue === d.intent.venue && x.marketId === d.intent.marketId)
	const what = `${d.intent.side} ${d.intent.size} @ ${d.intent.limit} "${m?.question ?? d.intent.marketId}" [${m?.category ?? '?'}]`
	return d.approved ? what : `${what} -> ${d.reasons.join(', ')}`
}

// ─── Init ───────────────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)]
}
