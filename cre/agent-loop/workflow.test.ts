import { describe, expect } from 'bun:test'
import { HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import kalshiFixture from '../../services/fixtures/kalshi-events.json'
import fixtureMarkets from '../../services/fixtures/polymarket-markets.json'
import type { GammaMarket, KalshiEventsResponse, Policy, Portfolio, ScoreRequest, Signal } from '../../packages/core/src'
import { loadPaymentConfig } from '../../services/cardano-agents-ts/config'
import { createPaymentRuntime } from '../../services/cardano-agents-ts/runtime'
import { scoreInputHash } from '../../services/cardano-agents-ts/types'
import { type Config, configSchema, initWorkflow, onCron } from './workflow'

const config: Config = {
	schedule: '0 */1 * * * *',
	venueUrls: { polymarket: 'http://polymarket.test/markets', kalshi: 'http://kalshi.test/events' },
	controlApiUrl: 'http://control.test',
	cardanoAgentUrl: 'http://cardano.test',
	scoreUrl: 'http://score.test/score',
	maxDataPaymentLovelace: 2_000_000,
	strategy: { minEdge: 0.04, minConfidence: 0.5, stake: 20, maxIntents: 5, minLiquidity: 1000, minPrice: 0.05, maxPrice: 0.95 },
}

const policy: Policy = {
	max_bet: 25,
	max_daily_loss: 100,
	category_allow: [],
	category_deny: ['politics'],
	venues_enabled: ['polymarket', 'kalshi'],
	stop_loss_pct: 0.2,
	kill_switch: false,
}

const portfolio: Portfolio = { cash: 1000, equity: 1000, startOfDayEquity: 1000, highWaterMark: 1000, dailyPnl: 0, positions: [] }

const requirement = {
	scheme: 'exact',
	network: 'cardano-preprod',
	maxAmountRequired: '1000000',
	asset: 'lovelace',
	payTo: 'addr_test_provider',
	resource: config.scoreUrl,
	description: 'scores',
	maxTimeoutSeconds: 60,
}

// Fair value 0.15 above every market's price, so every market is a candidate.
const signalsFor = (body: ScoreRequest) =>
	body.markets.map((m) => ({ venue: m.venue, marketId: m.marketId, fairYes: Math.min(0.99, m.yesPrice + 0.15), confidence: 0.9 }))

type Call = { method: string; url: string; headers: Record<string, string>; body: any }

// Routes the HTTP capability to canned responses and records each call.
const fakeServices = (opts: {
	policy?: Partial<Policy>; portfolio?: Partial<Portfolio>; price?: unknown; kalshiDown?: boolean;
	inputHash?: unknown;
	polymarket?: GammaMarket[]; kalshi?: KalshiEventsResponse; signals?: Signal[];
	fillModes?: ('paper' | 'live')[]; fillStatuses?: ('filled' | 'rejected')[]; rejected?: boolean; emptyFills?: boolean;
} = {}) => {
	const calls: Call[] = []
	const reply = (statusCode: number, body: unknown) => ({
		statusCode,
		body: new TextEncoder().encode(JSON.stringify(body)),
	})

	HttpActionsMock.testInstance().sendRequest = (req) => {
		const headers: Record<string, string> = {}
		for (const [k, v] of Object.entries(req.multiHeaders ?? {})) headers[k.toLowerCase()] = v.values[0]
		const body = req.body?.length ? JSON.parse(new TextDecoder().decode(req.body)) : null
		calls.push({ method: req.method, url: req.url, headers, body })

		switch (`${req.method} ${req.url}`) {
			case 'GET http://control.test/agent/state':
				return reply(200, { policy: { ...policy, ...opts.policy }, portfolio: { ...portfolio, ...opts.portfolio } })
			case 'GET http://polymarket.test/markets':
				return reply(200, opts.polymarket ?? fixtureMarkets)
			case 'GET http://kalshi.test/events':
				return opts.kalshiDown ? reply(503, { error: 'down' }) : reply(200, opts.kalshi ?? kalshiFixture)
			case 'POST http://score.test/score':
				if (!headers['x-payment']) {
					return reply(402, { x402Version: 1, accepts: [{
						...requirement,
						maxAmountRequired: opts.price !== undefined ? opts.price : '1000000',
						inputHash: Object.hasOwn(opts, 'inputHash') ? opts.inputHash : scoreInputHash(body),
					}] })
				}
				return reply(200, { signals: opts.signals ?? signalsFor(body) })
			case 'POST http://cardano.test/pay':
				return reply(200, { receipt: { receiptId: 'rcpt_1', txHash: 'ab'.repeat(32), amount: 1_000_000 }, xPayment: 'eyJwYWlkIjp0cnVlfQ==' })
			case 'POST http://control.test/orders':
				return reply(200, {
					fills: opts.emptyFills ? [] : body.orders.map((o: any, index: number) => ({
						idempotencyKey: o.idempotencyKey,
						status: opts.fillStatuses?.[index % opts.fillStatuses.length] ?? (opts.rejected ? 'rejected' : 'filled'),
						mode: opts.fillModes?.[index % opts.fillModes.length] ?? 'paper',
						marketId: o.intent.marketId,
						side: o.intent.side,
						size: o.intent.size,
						price: o.intent.limit,
						reason: o.intent.reason,
					})),
				})
			case 'POST http://control.test/audit':
				return reply(200, { ok: true })
		}
		return reply(404, { error: `unexpected ${req.method} ${req.url}` })
	}
	return calls
}

const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url.replace(/^http:\/\/|\?.*$/g, '')}`)
const auditEvents = (calls: Call[]): { type: string; detail: string }[] =>
	calls.find((c) => c.url.endsWith('/audit'))!.body.events

describe('onCron', () => {
	test('runs the full cycle: state, markets, x402 pay, score, gate, orders, audit', () => {
		const calls = fakeServices()
		const summary = onCron(newTestRuntime(null, {}, config))

		expect(paths(calls)).toEqual([
			'GET control.test/agent/state',
			'GET polymarket.test/markets',
			'GET kalshi.test/events',
			'POST score.test/score',
			'POST cardano.test/pay',
			'POST score.test/score',
			'POST control.test/orders',
			'POST control.test/audit',
		])
		// Paid retry carries the X-PAYMENT header from the Cardano agent service.
		expect(calls[5].headers['x-payment']).toBe('eyJwYWlkIjp0cnVlfQ==')
		expect(calls[4].body.idempotencyKey).toEndWith(':score')
		expect(summary).toMatch(/^\d+ proposed, \d+ approved, \d+ filled \(paper\)$/)
	})

	test('preserves the quoted input hash and binds the payment receipt to the score request', async () => {
		const calls = fakeServices()
		onCron(newTestRuntime(null, {}, config))
		const scoreRequest: ScoreRequest = calls.find((c) => c.url === config.scoreUrl)!.body
		const inputHash = scoreInputHash(scoreRequest)
		const payBody = calls.find((c) => c.url.endsWith('/pay'))!.body
		expect(payBody.requirement).toEqual({ ...requirement, inputHash })

		const runtime = createPaymentRuntime({ config: loadPaymentConfig({
			CARDANO_RECEIPT_DB: ':memory:', SCORE_PAY_TO: requirement.payTo,
		}) })
		try {
			const paid = await runtime.pay(payBody)
			expect(paid.receipt.inputHash).toBe(inputHash)
			const verification = {
				xPayment: paid.xPayment, resource: requirement.resource,
				amount: paid.receipt.amount, payTo: requirement.payTo, inputHash,
			}
			expect(await runtime.verify(verification)).toMatchObject({ valid: true, receiptId: paid.receipt.receiptId })
			const changedRequest: ScoreRequest = { markets: scoreRequest.markets.map((market, index) =>
				index === 0 ? { ...market, yesPrice: market.yesPrice === 0 ? 1 : 0 } : market,
			) }
			await expect(runtime.verify({ ...verification, inputHash: scoreInputHash(changedRequest) }))
				.rejects.toThrow('payment proof does not match the request')
		} finally {
			runtime.close()
		}
	})

	test('refuses missing or malformed input hashes before paying or placing orders', () => {
		const invalidHashes = [
			undefined, null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64),
			'A'.repeat(64), `${'a'.repeat(64)} `, 64, false,
		]
		for (const inputHash of invalidHashes) {
			const calls = fakeServices({ inputHash })
			expect(onCron(newTestRuntime(null, {}, config))).toBe('invalid data payment: no orders placed')
			expect(paths(calls)).not.toContain('POST cardano.test/pay')
			expect(paths(calls)).not.toContain('POST control.test/orders')
			expect(auditEvents(calls).some((event) => event.type === 'payment_refused')).toBe(true)
		}
	})

	test('does not purchase scores or send orders for politics markets', () => {
		const calls = fakeServices()
		onCron(newTestRuntime(null, {}, config))

		const orders = calls.find((c) => c.url.endsWith('/orders'))!.body.orders
		const politicsIds = new Set(
			(fixtureMarkets as { id: string; tags: { slug: string }[] }[])
				.filter((m) => m.tags.some((t) => t.slug === 'politics'))
				.map((m) => m.id),
		)
		expect(orders.length).toBeGreaterThan(0)
		expect(orders.some((o: any) => politicsIds.has(o.intent.marketId))).toBe(false)
		const scored = calls.find((c) => c.url === config.scoreUrl)!.body.markets
		expect(scored.some((m: any) => politicsIds.has(m.marketId))).toBe(false)
		// Stable, unique idempotency keys per order.
		expect(new Set(orders.map((o: any) => o.idempotencyKey)).size).toBe(orders.length)
	})

	test('scores and trades markets from both venues', () => {
		const calls = fakeServices()
		onCron(newTestRuntime(null, {}, config))

		const scored = calls.find((c) => c.url === config.scoreUrl)!.body.markets.map((m: any) => m.marketId)
		expect(scored.some((id: string) => id.startsWith('KX'))).toBe(true)
		expect(scored.some((id: string) => /^\d+$/.test(id))).toBe(true)
		const venues = calls.find((c) => c.url.endsWith('/orders'))!.body.orders.map((o: any) => o.intent.venue)
		expect(new Set(venues)).toEqual(new Set(['polymarket', 'kalshi']))
	})

	test('skips venues the policy disables', () => {
		const calls = fakeServices({ policy: { venues_enabled: ['polymarket'] } })
		onCron(newTestRuntime(null, {}, config))

		expect(paths(calls)).not.toContain('GET kalshi.test/events')
		const venues = calls.find((c) => c.url.endsWith('/orders'))!.body.orders.map((o: any) => o.intent.venue)
		expect(venues.every((v: string) => v === 'polymarket')).toBe(true)
	})

	test('a failing venue is logged and the cycle continues on the others', () => {
		const calls = fakeServices({ kalshiDown: true })
		const summary = onCron(newTestRuntime(null, {}, config))

		expect(auditEvents(calls).find((e) => e.type === 'venue_error')!.detail).toStartWith('kalshi:')
		expect(paths(calls)).toContain('POST control.test/orders')
		expect(summary).toMatch(/filled \(paper\)$/)
	})

	test('kill switch halts before buying data or placing orders', () => {
		const calls = fakeServices({ policy: { kill_switch: true } })
		const summary = onCron(newTestRuntime(null, {}, config))

		expect(summary).toStartWith('halted')
		expect(paths(calls)).toEqual(['GET control.test/agent/state', 'POST control.test/audit'])
		expect(auditEvents(calls).find((e) => e.type === 'halted')!.detail).toBe('kill_switch_on')
	})

	test('refuses to pay above the data payment cap', () => {
		const calls = fakeServices({ price: '5000000' })
		const summary = onCron(newTestRuntime(null, {}, config))

		expect(summary).toBe('data too expensive: no orders placed')
		expect(paths(calls)).not.toContain('POST cardano.test/pay')
		expect(paths(calls)).not.toContain('POST control.test/orders')
	})

	test('refuses malformed payment amounts before calling the payment service', () => {
		for (const price of ['NaN', 'Infinity', '-1', '0', '1.5', '1e6', '0x10', '9007199254740993', '', ' ', 1000000, null, true]) {
			const calls = fakeServices({ price })
			expect(onCron(newTestRuntime(null, {}, config))).toBe('invalid data payment: no orders placed')
			expect(paths(calls)).not.toContain('POST cardano.test/pay')
			expect(paths(calls)).not.toContain('POST control.test/orders')
			expect(auditEvents(calls).some((e) => e.type === 'payment_refused')).toBe(true)
		}
	})

	test('validates the configured payment cap and refuses an invalid runtime cap', () => {
		for (const cap of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(configSchema.safeParse({ ...config, maxDataPaymentLovelace: cap }).success).toBe(false)
			const calls = fakeServices()
			expect(onCron(newTestRuntime(null, {}, { ...config, maxDataPaymentLovelace: cap }))).toBe('invalid data payment cap: no orders placed')
			expect(paths(calls)).not.toContain('POST cardano.test/pay')
		}
		const calls = fakeServices({ price: String(config.maxDataPaymentLovelace) })
		onCron(newTestRuntime(null, {}, config))
		expect(paths(calls)).toContain('POST cardano.test/pay')
	})

	test('does not buy scores when no market can pass policy or the strategy', () => {
		for (const options of [
			{ policy: { max_bet: 0 } },
			{ portfolio: { cash: 0 } },
			{ policy: { category_allow: ['not-allowed'] } },
		]) {
			const calls = fakeServices(options)
			expect(onCron(newTestRuntime(null, {}, config))).toStartWith('no eligible markets:')
			expect(paths(calls)).not.toContain('POST score.test/score')
			expect(paths(calls)).not.toContain('POST cardano.test/pay')
			expect(paths(calls)).not.toContain('POST control.test/orders')
		}
		for (const strategy of [{ ...config.strategy, maxIntents: 0 }, { ...config.strategy, stake: 0 }]) {
			const calls = fakeServices()
			expect(onCron(newTestRuntime(null, {}, { ...config, strategy }))).toStartWith('no eligible markets:')
			expect(paths(calls)).not.toContain('POST score.test/score')
		}
	})

	test('uses actual successful fill modes in the summary and cycle-end audit', () => {
		for (const [fillModes, expected] of [
			[['paper'], 'paper'], [['live'], 'live'], [['paper', 'live'], 'mixed: live/paper'],
		] as [ ('paper' | 'live')[], string ][]) {
			const calls = fakeServices({ fillModes })
			const summary = onCron(newTestRuntime(null, {}, config))
			expect(summary).toEndWith(`(${expected})`)
			expect(auditEvents(calls).find((e) => e.type === 'cycle_end')!.detail).toBe(summary)
		}
		for (const options of [{ rejected: true }, { emptyFills: true }]) {
			fakeServices(options)
			expect(onCron(newTestRuntime(null, {}, config))).toEndWith('0 filled (no fills)')
		}
		fakeServices({ fillModes: ['live', 'paper'], fillStatuses: ['filled', 'rejected'] })
		expect(onCron(newTestRuntime(null, {}, config))).toEndWith('(live)')
	})

	test('blocked markets cannot crowd out an allowed market with maxIntents one', () => {
		const blocked = gammaMarket('blocked', { tags: [{ slug: 'politics' }] })
		const allowed = gammaMarket('allowed')
		const calls = fakeServices({ polymarket: [blocked, allowed], policy: { venues_enabled: ['polymarket'] } })
		onCron(newTestRuntime(null, {}, { ...config, strategy: { ...config.strategy, maxIntents: 1 } }))
		expect(calls.find((c) => c.url === config.scoreUrl)!.body.markets.map((m: any) => m.marketId)).toEqual(['allowed'])
		expect(calls.find((c) => c.url.endsWith('/orders'))!.body.orders.map((o: any) => o.intent.marketId)).toEqual(['allowed'])
	})

	test('fills a later affordable proposal when the highest-edge side fails policy', () => {
		const calls = fakeServices({
			polymarket: [gammaMarket('expensive-side', { bestBid: 0.79, bestAsk: 0.81 }), gammaMarket('affordable', { bestBid: 0.64, bestAsk: 0.65 })],
			policy: { venues_enabled: ['polymarket'], max_bet: 19.5 },
			signals: [
				{ venue: 'polymarket', marketId: 'expensive-side', fairYes: 0.2, confidence: 1 },
				{ venue: 'polymarket', marketId: 'affordable', fairYes: 0.85, confidence: 1 },
			],
		})
		onCron(newTestRuntime(null, {}, { ...config, strategy: { ...config.strategy, maxIntents: 1 } }))
		expect(calls.find((c) => c.url.endsWith('/orders'))!.body.orders.map((o: any) => o.intent.marketId)).toEqual(['affordable'])
		expect(auditEvents(calls).some((e) => e.type === 'policy_blocked' && e.detail.includes('max_bet_exceeded'))).toBe(true)
	})

	test('separates score requests, decisions, and orders for colliding venue IDs', () => {
		const calls = fakeServices({
			polymarket: [gammaMarket('same-id', { question: 'Polymarket question' })],
			kalshi: { events: [{ event_ticker: 'event', category: 'Sports', title: 'event', markets: [{
				ticker: 'same-id', title: 'Kalshi question', market_type: 'binary', status: 'active',
				yes_bid_dollars: '0.49', yes_ask_dollars: '0.51', open_interest_fp: '50000',
			}] }] },
			signals: [
				{ venue: 'polymarket', marketId: 'same-id', fairYes: 0.8, confidence: 1 },
				{ venue: 'kalshi', marketId: 'same-id', fairYes: 0.2, confidence: 1 },
			],
		})
		onCron(newTestRuntime(null, {}, config))
		expect(calls.find((c) => c.url === config.scoreUrl)!.body.markets.map((m: any) => [m.venue, m.marketId])).toEqual([['polymarket', 'same-id'], ['kalshi', 'same-id']])
		const orders = calls.find((c) => c.url.endsWith('/orders'))!.body.orders
		expect(orders.map((o: any) => [o.intent.venue, o.intent.side]).sort()).toEqual([['kalshi', 'no'], ['polymarket', 'yes']])
		const approved = auditEvents(calls).filter((e) => e.type === 'policy_approved')
		expect(approved.some((e) => e.detail.includes('Kalshi question') && e.detail.startsWith('no '))).toBe(true)
	})
})

function gammaMarket(id: string, over: Partial<GammaMarket> = {}): GammaMarket {
	return {
		id, question: id, outcomes: '["Yes", "No"]', outcomePrices: '["0.5", "0.5"]',
		bestBid: 0.49, bestAsk: 0.51, liquidityNum: 50000, tags: [{ slug: 'sports' }], ...over,
	}
}

describe('initWorkflow', () => {
	test('registers one cron handler', () => {
		const handlers = initWorkflow(config)
		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCron)
	})
})
