import { useCallback, useEffect, useRef, useState } from 'react'

export type Venue = 'polymarket' | 'kalshi'
export type Side = 'yes' | 'no'
export type AuditEvent = { type: string; detail: string }

export type Policy = {
  max_bet: number
  max_daily_loss: number
  category_allow: string[]
  category_deny: string[]
  venues_enabled: Venue[]
  stop_loss_pct: number
  kill_switch: boolean
}

export type Position = {
  venue: Venue
  marketId: string
  side: Side
  size: number
  avgPrice: number
  markPrice: number
  marketValue: number
  unrealizedPnl: number
  markStatus: 'entry' | 'current' | 'stale'
}

export type Portfolio = {
  cash: number
  equity: number
  startOfDayEquity: number
  highWaterMark: number
  dailyPnl: number
  positions: Position[]
  realizedPnl: number
  unrealizedPnl: number
}

export type AgentState = {
  policy: Policy
  portfolio: Portfolio
  halt: { halted: boolean; reasons: string[] }
}

export type Strategy = {
  minEdge: number
  minConfidence: number
  stake: number
  maxIntents: number
  minLiquidity: number
  minPrice: number
  maxPrice: number
}

export type Cycle = { cycleId: string; startedAt: string; finishedAt: string; summary: string; events: AuditEvent[] }

export type Status = {
  services: { control: boolean; cardano: boolean; score: boolean; feed: boolean }
  managed: boolean
  logs: string[]
  auto: { enabled: boolean; seconds: number; nextAt: number; running: boolean }
  settings: { strategy: Strategy; maxDataPaymentLovelace: number }
  cycles: Cycle[]
}

export type Market = {
  venue: Venue
  marketId: string
  question: string
  category: string
  bestBid: number
  bestAsk: number
  yesPrice: number
  liquidity: number
  endDate: string
  eligible: boolean
  held: boolean
  blocked: string[]
}

export type FeedStatus = { venue: Venue; markets: number; ageSeconds: number | null; stale: boolean; lastError: string }

export type Receipt = {
  receiptId: string
  amount: number
  status: string
  simulated: boolean
  txHash: string
  createdAt: string
}

export type Wallet = { address: string; network: string; balanceLovelace: number; simulated: boolean }
export type AuditEntry = { cycleId: string; receivedAt: string; events: AuditEvent[] }

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch(path, { ...init, cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `${path} returned ${res.status}`)
  return data as T
}

/** Polls an endpoint. Keeps the last good value when a poll fails. */
export function usePoll<T>(path: string, ms: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    try {
      const v = await api<T>(path)
      if (alive.current) { setData(v); setError(null) }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [path])
  useEffect(() => {
    alive.current = true
    let t: ReturnType<typeof setTimeout>
    const loop = async () => { await refresh(); if (alive.current) t = setTimeout(loop, ms) }
    loop()
    return () => { alive.current = false; clearTimeout(t) }
  }, [refresh, ms])
  return { data, error, refresh }
}

export const money = (n: number | undefined) => {
  if (n === undefined || !Number.isFinite(n)) return '–'
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '−' : ''}$${s}`
}
export const signed = (n: number | undefined) => (n !== undefined && n > 0.004 ? '+' : '') + money(n)
export const tone = (n: number | undefined) => (n === undefined ? '' : n > 0.004 ? 'text-acid' : n < -0.004 ? 'text-loss' : 'text-fg')
export const cents = (p: number) => (Number.isFinite(p) ? `${+(p * 100).toFixed(1)}¢` : '–')
export const compact = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : '–')
export const venueName = (v: string) => (v === 'polymarket' ? 'Polymarket' : v === 'kalshi' ? 'Kalshi' : v)
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const stamp = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
