import { z } from 'zod'

// ─── Config ─────────────────────────────────────────────────
export const configSchema = z.object({
	schedule: z.string(),
	// Market read URLs per venue (live API or the control API's offline fixture).
	// An empty string skips that venue.
	venueUrls: z.object({
		polymarket: z.string(),
		kalshi: z.string(),
	}),
	controlApiUrl: z.string(),
	cardanoAgentUrl: z.string(),
	scoreUrl: z.string(),
	// The workflow refuses any single data payment above this.
	maxDataPaymentLovelace: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	strategy: z.object({
		minEdge: z.number(),
		minConfidence: z.number(),
		stake: z.number(),
		maxIntents: z.number().int().nonnegative(),
		minLiquidity: z.number(),
		minPrice: z.number(),
		maxPrice: z.number(),
	}),
})
export type Config = z.infer<typeof configSchema>
