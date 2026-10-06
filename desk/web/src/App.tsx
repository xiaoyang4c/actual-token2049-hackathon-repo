import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, OctagonX, Power, Zap } from 'lucide-react'
import Silk from '@/components/Silk'
import DecryptedText from '@/components/DecryptedText'
import ShinyText from '@/components/ShinyText'
import BlurText from '@/components/BlurText'
import StarBorder from '@/components/StarBorder'
import Magnet from '@/components/Magnet'
import ClickSpark from '@/components/ClickSpark'
import {
  api, cents, compact, money, signed, stamp, tone, usePoll, venueName,
  type AgentState, type AuditEntry, type Cycle, type FeedStatus, type Market, type Policy, type Receipt, type Status, type Wallet,
} from '@/api'
import { ArmButton, btn, Chip, Field, Money, Panel, ToastHost, useToast } from '@/desk/ui'
import { Dispatch, Pipeline } from '@/desk/cycle'

const CATEGORIES = ['politics', 'sports', 'crypto', 'economy', 'tech', 'culture', 'science', 'weather', 'other']
const VENUES = ['polymarket', 'kalshi'] as const

export default function App() {
  return (
    <ToastHost>
      <Desk />
    </ToastHost>
  )
}

function Desk() {
  const status = usePoll<Status>('/api/status', 1500)
  const state = usePoll<AgentState>('/api/state', 2000)
  const markets = usePoll<Market[]>('/api/markets', 12000)
  const feed = usePoll<FeedStatus[]>('/api/feed', 12000)
  const receipts = usePoll<Receipt[]>('/api/receipts', 5000)
  const wallet = usePoll<Wallet>('/api/wallet', 15000)
  const audit = usePoll<AuditEntry[]>('/api/audit', 5000)
  const toast = useToast()
  const [running, setRunning] = useState(false)

  const s = status.data
  const st = state.data
  const up = s ? Object.values(s.services).filter(Boolean).length : 0
  const busy = running || Boolean(s?.auto.running)

  const lastCycle: Cycle | null = useMemo(() => {
    if (s?.cycles?.[0]) return s.cycles[0]
    const a = audit.data?.at(-1)
    if (!a) return null
    const end = a.events.find((e) => e.type === 'cycle_end')
    return { cycleId: a.cycleId, startedAt: a.receivedAt, finishedAt: a.receivedAt, summary: end?.detail ?? '', events: a.events }
  }, [s, audit.data])

  const refreshAll = () => Promise.all([status.refresh(), state.refresh(), markets.refresh(), receipts.refresh(), audit.refresh()])

  const runCycle = async () => {
    if (busy) return
    setRunning(true)
    try {
      const r = await api<Cycle>('/api/cycle', {})
      toast(r.summary, r.summary.startsWith('halted') || r.summary === 'cycle failed')
    } catch (e) {
      toast((e as Error).message, true)
    }
    await refreshAll()
    setRunning(false)
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 opacity-[0.9]">
          <Silk speed={2.2} scale={1.1} color={st?.halt.halted ? '#4a1c26' : '#2a3a26'} noiseIntensity={1.2} rotation={0.2} />
        </div>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(7,8,11,.15)_0%,#07080b_80%)]" />
      </div>

      <TopBar status={s} up={up} />

      <main className="mx-auto max-w-[1400px] px-4 pb-24 sm:px-6 lg:px-10">
        <Hero state={st} busy={busy} onRun={runCycle} status={s} />

        <AnimatePresence>
          {st?.halt.halted && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-6 flex items-start gap-3 rounded-2xl border border-loss/40 bg-loss/10 px-5 py-4 text-loss backdrop-blur-xl">
                <OctagonX size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Trading halted. The next cycle buys no data and places no orders.</p>
                  <p className="num mt-1 text-[12px] text-loss/80">{st.halt.reasons.join(' · ').replace(/_/g, ' ')}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <section className="mt-6">
          <CyclePanel cycle={lastCycle} running={busy} />
        </section>

        <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Positions state={st} markets={markets.data ?? []} onChange={refreshAll} />
            <Markets markets={markets.data ?? []} feed={feed.data ?? []} />
            <Payments receipts={receipts.data ?? []} wallet={wallet.data} />
            <CycleLog audit={audit.data ?? []} />
          </div>
          <div className="space-y-6">
            <PolicyPanel policy={st?.policy} onSaved={() => { state.refresh(); markets.refresh() }} />
            <StrategyPanel status={s} onSaved={() => { status.refresh(); markets.refresh() }} />
            <StressPanel onDone={refreshAll} />
            <BackendPanel status={s} onChange={status.refresh} />
          </div>
        </section>
      </main>
    </div>
  )
}

// ─── Top bar ──────────────────────────────────────────────────────
function TopBar({ status, up }: { status: Status | null; up: number }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink/55 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-acid text-ink"><Zap size={15} strokeWidth={2.5} /></span>
          <DecryptedText text="AGENT DESK" animateOn="view" sequential speed={45} className="num text-[13px] font-semibold tracking-[0.18em] text-fg" encryptedClassName="num text-[13px] tracking-[0.18em] text-acid" />
        </div>
        <div className="flex items-center gap-5 text-[12px]">
          <span className="hidden text-dim md:inline">
            <span className={up === 4 ? 'text-acid' : 'text-loss'}>{status ? `${up}/4 services` : 'desk offline'}</span>
            <span className="mx-2 text-faint">/</span>paper fills<span className="mx-2 text-faint">/</span>simulated ADA
          </span>
          <span className="num text-dim">{now.toISOString().slice(11, 19)} UTC</span>
        </div>
      </div>
    </header>
  )
}

// ─── Hero: equity + controls ──────────────────────────────────────
function Hero({ state, busy, onRun, status }: { state: AgentState | null; busy: boolean; onRun: () => void; status: Status | null }) {
  const p = state?.portfolio
  const pol = state?.policy
  const toast = useToast()

  const used = p && pol ? Math.max(0, -p.dailyPnl) : 0
  const dailyFrac = p && pol ? (pol.max_daily_loss > 0 ? Math.min(1, used / pol.max_daily_loss) : 1) : 0
  const floor = p && pol ? p.highWaterMark * (1 - pol.stop_loss_pct) : 0
  const stopFrac = p && pol ? Math.min(1, Math.max(0, (p.highWaterMark - p.equity) / Math.max(1e-9, p.highWaterMark - floor))) : 0

  const setKill = async () => {
    try {
      await api('/api/policy', { kill_switch: !pol?.kill_switch })
      toast(pol?.kill_switch ? 'Kill switch off. The agent may trade.' : 'Kill switch on. The next cycle halts.', !pol?.kill_switch)
    } catch (e) { toast((e as Error).message, true) }
  }

  const setAuto = async (enabled: boolean, seconds = status?.auto.seconds ?? 60) => {
    try { await api('/api/auto', { enabled, seconds }) } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <section className="grid grid-cols-1 gap-6 pt-10 lg:grid-cols-[minmax(0,1fr)_380px] lg:pt-14">
      <div>
        <p className="label">Equity, paper book</p>
        <div className="mt-2 text-[clamp(56px,10vw,128px)] font-semibold leading-[0.9] tracking-[-0.045em] text-fg">
          {p ? <Money value={p.equity} /> : <span className="text-faint">$–</span>}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
          {[
            ['Cash', p?.cash, false],
            ['Today', p?.dailyPnl, true],
            ['Unrealized', p?.unrealizedPnl, true],
            ['Realized', p?.realizedPnl, true],
          ].map(([label, v, sign]) => (
            <div key={label as string}>
              <p className="label">{label as string}</p>
              <p className={`num mt-1 text-[20px] ${sign ? tone(v as number) : 'text-fg'}`}>
                {v === undefined ? '–' : <Money value={v as number} sign={sign as boolean} />}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 grid max-w-[640px] grid-cols-1 gap-5 sm:grid-cols-2">
          <Meter label="Daily loss limit" frac={dailyFrac} text={pol ? `${money(used)} of ${money(pol.max_daily_loss)}` : '–'} />
          <Meter label="Stop-loss floor" frac={stopFrac} text={p ? `${money(floor)} · ${money(Math.max(0, p.equity - floor))} above` : '–'} />
        </div>
      </div>

      <div className="glass flex flex-col gap-4 rounded-[26px] p-5">
        <ClickSpark sparkColor="#c4f25b" sparkCount={10} sparkRadius={28} sparkSize={12}>
          <Magnet padding={60} magnetStrength={6} wrapperClassName="!block w-full" innerClassName="w-full">
            <StarBorder
              onClick={onRun}
              disabled={busy || !status?.services.control}
              color="#c4f25b"
              speed="4s"
              thickness={2}
              backgroundColor="#0d110c"
              borderColor="rgba(196,242,91,.35)"
              className="w-full !rounded-[18px] disabled:cursor-not-allowed disabled:opacity-60 [&>div:last-child]:!rounded-[18px]"
            >
              <span className="flex items-center justify-center gap-2 text-[17px] font-medium">
                {busy ? <ShinyText text="Running a cycle" speed={1.6} color="#7f8a6a" shineColor="#c4f25b" /> : <>Run one cycle <span className="num text-[12px] text-acid/80">1 ADA</span></>}
              </span>
            </StarBorder>
          </Magnet>
        </ClickSpark>

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[13px]">
          <label className="flex cursor-pointer items-center gap-3">
            <Toggle on={Boolean(status?.auto.enabled)} onClick={() => setAuto(!status?.auto.enabled)} />
            <span>Auto-run</span>
          </label>
          <span className="flex items-center gap-1.5 text-dim">
            every
            <input
              type="number"
              min={10}
              max={3600}
              defaultValue={status?.auto.seconds ?? 60}
              key={status?.auto.seconds}
              onBlur={(e) => status?.auto.enabled && setAuto(true, Number(e.target.value))}
              className="num w-12 rounded-md border border-white/10 bg-transparent px-1.5 py-0.5 text-right text-fg outline-none focus:border-acid/60"
            />
            s
          </span>
        </div>
        {status?.auto.enabled && <AutoCountdown nextAt={status.auto.nextAt} />}

        <button
          onClick={setKill}
          className={`group flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-colors ${
            pol?.kill_switch ? 'border-loss/60 bg-loss/15' : 'border-white/[0.07] bg-white/[0.02] hover:border-loss/40'
          }`}
        >
          <span>
            <span className={`flex items-center gap-2 text-[15px] font-medium ${pol?.kill_switch ? 'text-loss' : 'text-fg'}`}>
              <Power size={16} /> Kill switch {pol?.kill_switch ? 'on' : 'off'}
            </span>
            <span className="mt-0.5 block text-[12px] text-dim">
              {pol?.kill_switch ? 'The next cycle stops before it spends anything.' : 'Stops the next cycle before it buys data.'}
            </span>
          </span>
          <Toggle on={Boolean(pol?.kill_switch)} danger />
        </button>
      </div>
    </section>
  )
}

function AutoCountdown({ nextAt }: { nextAt: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [])
  return <p className="num -mt-2 px-1 text-[11px] text-dim">next cycle in {Math.max(0, Math.round((nextAt - Date.now()) / 1000))}s</p>
}

function Toggle({ on, onClick, danger }: { on: boolean; onClick?: () => void; danger?: boolean }) {
  return (
    <span
      role={onClick ? 'switch' : undefined}
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full border transition-colors ${
        on ? (danger ? 'border-loss bg-loss/40' : 'border-acid bg-acid/30') : 'border-white/15 bg-white/[0.05]'
      }`}
    >
      <motion.span
        initial={false}
        animate={{ x: on ? 18 : 0 }}
        transition={{ type: 'spring', stiffness: 600, damping: 32 }}
        className={`absolute left-[2px] h-[16px] w-[16px] rounded-full ${on ? (danger ? 'bg-loss' : 'bg-acid') : 'bg-dim'}`}
      />
    </span>
  )
}

function Meter({ label, frac, text }: { label: string; frac: number; text: string }) {
  const warn = frac >= 0.75
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`num text-[11px] ${warn ? 'text-loss' : 'text-dim'}`}>{text}</span>
      </div>
      <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-white/[0.07]">
        <motion.div
          className={`h-full rounded-full ${warn ? 'bg-loss' : 'bg-acid'}`}
          animate={{ width: `${Math.max(frac * 100, frac > 0 ? 2 : 0)}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  )
}

// ─── Last cycle ──────────────────────────────────────────────────
function CyclePanel({ cycle, running }: { cycle: Cycle | null; running: boolean }) {
  const end = cycle?.events.find((e) => e.type === 'cycle_end')?.detail ?? cycle?.summary
  return (
    <Panel
      title="Last cycle"
      aside={cycle && <span className="num text-[11px] text-faint">{stamp(cycle.finishedAt)}</span>}
    >
      <Pipeline events={cycle?.events ?? []} running={running} />
      <div className="mt-6 border-t border-white/[0.06] pt-5">
        {cycle ? (
          <>
            <BlurText key={cycle.cycleId} text={end ?? ''} animateBy="words" delay={60} className="text-[22px] font-medium tracking-tight text-fg sm:text-[26px]" />
            <div className="mt-4 max-h-[420px] overflow-y-auto pr-1 scroll-thin">
              <Dispatch key={cycle.cycleId} events={cycle.events} />
            </div>
          </>
        ) : (
          <p className="text-[15px] text-dim">No cycle yet. Press <span className="text-acid">Run one cycle</span> to read the markets, buy scores, and place paper orders.</p>
        )}
      </div>
    </Panel>
  )
}

// ─── Positions ───────────────────────────────────────────────────
function Positions({ state, markets, onChange }: { state: AgentState | null; markets: Market[]; onChange: () => void }) {
  const toast = useToast()
  const [settling, setSettling] = useState<string | null>(null)
  const names = useMemo(() => new Map(markets.map((m) => [`${m.venue}:${m.marketId}`, m.question])), [markets])
  const rows = state?.portfolio.positions ?? []

  const close = async (venue: string, marketId: string, side: string) => {
    try {
      const r = await api<{ size: number; price: number; realizedPnl: number }>('/api/close', { idempotencyKey: `desk-close-${crypto.randomUUID()}`, venue, marketId, side })
      toast(`Sold ${r.size} ${side.toUpperCase()} at ${cents(r.price)}. Realized ${signed(r.realizedPnl)}.`)
      onChange()
    } catch (e) { toast((e as Error).message, true) }
  }
  const settle = async (venue: string, marketId: string, outcome: string) => {
    try {
      const r = await api<{ realizedPnl: number }>('/api/resolve', { idempotencyKey: `desk-resolve-${crypto.randomUUID()}`, venue, marketId, outcome })
      toast(`Settled as ${outcome}. Realized ${signed(r.realizedPnl)}.`)
      setSettling(null)
      onChange()
    } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <Panel title="Positions" aside={<span className="num text-[11px] text-dim">{rows.length} open</span>}>
      {rows.length === 0 ? (
        <p className="text-[14px] text-dim">The book holds no positions.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto scroll-thin">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="label text-left [&>th]:px-2 [&>th]:pb-2 [&>th]:font-normal">
                <th>Market</th><th>Side</th><th className="text-right">Shares</th><th className="text-right">Entry</th><th className="text-right">Mark</th><th className="text-right">P&amp;L</th><th />
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {rows.map((p) => {
                  const id = `${p.venue}:${p.marketId}:${p.side}`
                  return (
                    <motion.tr
                      key={id}
                      layout
                      initial={{ opacity: 0, backgroundColor: 'rgba(196,242,91,.12)' }}
                      animate={{ opacity: 1, backgroundColor: 'rgba(196,242,91,0)' }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.8 }}
                      className="border-t border-white/[0.05] [&>td]:px-2 [&>td]:py-2.5 align-top"
                    >
                      <td className="max-w-[300px]">
                        <p className="leading-snug text-fg">{names.get(`${p.venue}:${p.marketId}`) ?? p.marketId}</p>
                        <p className="num mt-0.5 text-[11px] text-faint">{venueName(p.venue)} · {p.marketId}</p>
                      </td>
                      <td><span className={`num rounded-md px-1.5 py-0.5 text-[11px] ${p.side === 'yes' ? 'bg-acid/12 text-acid' : 'bg-loss/12 text-loss'}`}>{p.side.toUpperCase()}</span></td>
                      <td className="num text-right">{p.size}</td>
                      <td className="num text-right text-dim">{cents(p.avgPrice)}</td>
                      <td className="num text-right">{p.markStatus === 'entry' ? <span className="text-faint">entry</span> : <>{cents(p.markPrice)}{p.markStatus === 'stale' && <span className="text-warn"> ·stale</span>}</>}</td>
                      <td className={`num text-right ${tone(p.unrealizedPnl)}`}>{signed(p.unrealizedPnl)}</td>
                      <td className="whitespace-nowrap text-right">
                        {settling === id ? (
                          <span className="inline-flex gap-1">
                            {(['yes', 'no', 'void'] as const).map((o) => (
                              <button key={o} className={`${btn} !px-2.5 !py-1 !text-[11px]`} onClick={() => settle(p.venue, p.marketId, o)}>{o === 'void' ? 'Void' : `${o.toUpperCase()} won`}</button>
                            ))}
                            <button className="px-1.5 text-[11px] text-dim hover:text-fg" onClick={() => setSettling(null)}>✕</button>
                          </span>
                        ) : (
                          <span className="inline-flex gap-1">
                            <ArmButton className={`${btn} !px-2.5 !py-1 !text-[11px]`} armedLabel="Sell at bid?" onConfirm={() => close(p.venue, p.marketId, p.side)}>Close</ArmButton>
                            <button className={`${btn} !px-2.5 !py-1 !text-[11px]`} onClick={() => setSettling(id)}>Settle</button>
                          </span>
                        )}
                      </td>
                    </motion.tr>
                  )
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

// ─── Markets ─────────────────────────────────────────────────────
function Markets({ markets, feed }: { markets: Market[]; feed: FeedStatus[] }) {
  const [venue, setVenue] = useState<'all' | 'polymarket' | 'kalshi'>('all')
  const [open, setOpen] = useState(false)
  const order = (m: Market) => (m.eligible ? 0 : m.held ? 1 : m.blocked.length ? 3 : 2)
  const list = markets.filter((m) => venue === 'all' || m.venue === venue).sort((a, b) => order(a) - order(b) || b.liquidity - a.liquidity)
  const shown = open ? list : list.slice(0, 8)
  const eligible = markets.filter((m) => m.eligible).length

  return (
    <Panel
      title="Live markets"
      aside={
        <div className="flex rounded-full border border-white/10 p-0.5 text-[11px]">
          {(['all', 'polymarket', 'kalshi'] as const).map((v) => (
            <button key={v} onClick={() => setVenue(v)} className={`relative rounded-full px-3 py-1 transition-colors ${venue === v ? 'text-ink' : 'text-dim hover:text-fg'}`}>
              {venue === v && <motion.span layoutId="venue-pill" className="absolute inset-0 rounded-full bg-fg" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
              <span className="relative">{v === 'all' ? 'All' : venueName(v)}</span>
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-4 text-[12px] text-dim">
        <span className="text-acid">{eligible} eligible</span> of {markets.length}. Eligible markets are the ones a cycle pays to score.
        {feed.map((f) => <span key={f.venue} className="num ml-2 text-faint">{venueName(f.venue)} {f.ageSeconds ?? '–'}s{f.stale ? ' stale' : ''}</span>)}
      </p>
      {markets.length === 0 ? (
        <p className="text-[14px] text-dim">The market feed has no data yet. It polls every 30 seconds.</p>
      ) : (
        <>
          <div className="-mx-1 overflow-x-auto scroll-thin">
            <table className="w-full min-w-[600px] text-[13px]">
              <thead>
                <tr className="label text-left [&>th]:px-2 [&>th]:pb-2 [&>th]:font-normal">
                  <th>Market</th><th className="text-right">Bid</th><th className="text-right">Ask</th><th className="text-right">Liq.</th><th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={`${m.venue}:${m.marketId}`} className="border-t border-white/[0.05] transition-colors hover:bg-white/[0.025] [&>td]:px-2 [&>td]:py-2.5 align-top">
                    <td className="max-w-[340px]">
                      <p className="leading-snug text-fg">{m.question}</p>
                      <p className="num mt-0.5 text-[11px] text-faint">{venueName(m.venue)} · {m.category}{m.endDate ? ` · ends ${new Date(m.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</p>
                    </td>
                    <td className="num text-right">{cents(m.bestBid)}</td>
                    <td className="num text-right">{cents(m.bestAsk)}</td>
                    <td className="num text-right text-dim">{compact(m.liquidity)}</td>
                    <td className="text-right">
                      <span className={`num whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] ${
                        m.held ? 'bg-white/[0.06] text-dim' : m.blocked.length ? 'bg-loss/12 text-loss' : m.eligible ? 'bg-acid/12 text-acid' : 'text-faint'
                      }`}>
                        {m.held ? 'held' : m.blocked.length ? m.blocked.join(', ') : m.eligible ? 'eligible' : 'outside strategy'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > 8 && (
            <button onClick={() => setOpen(!open)} className="mt-3 flex items-center gap-1 text-[12px] text-dim hover:text-fg">
              {open ? 'Show fewer' : `Show all ${list.length}`}
              <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </>
      )}
    </Panel>
  )
}

// ─── Payments ────────────────────────────────────────────────────
function Payments({ receipts, wallet }: { receipts: Receipt[]; wallet: Wallet | null }) {
  const list = [...receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const total = list.reduce((sum, r) => sum + r.amount, 0) / 1e6
  return (
    <Panel title="Data payments" tint="rgba(255, 198, 92, 0.08)" aside={<span className="num text-[11px] text-warn">{total.toLocaleString('en-US')} ADA spent</span>}>
      {wallet && (
        <p className="num mb-4 text-[11px] text-dim">
          wallet {wallet.address.slice(0, 28)}… · {wallet.network} · {wallet.simulated ? 'simulated' : 'live'}
          {Number.isFinite(wallet.balanceLovelace) && <> · balance <span className="text-fg">{(wallet.balanceLovelace / 1e6).toLocaleString('en-US')} ADA</span></>}
        </p>
      )}
      {list.length === 0 ? (
        <p className="text-[14px] text-dim">No data has been bought yet.</p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {list.slice(0, 10).map((r) => (
            <li key={r.receiptId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)_80px_120px]">
              <span className="num text-[12px] text-dim">{stamp(r.createdAt)}</span>
              <span className="num truncate text-[11px] text-faint max-sm:hidden">{r.receiptId}</span>
              <span className="num text-right text-warn">{(r.amount / 1e6).toLocaleString('en-US')} ADA</span>
              <span className="num text-right text-[11px] text-dim max-sm:hidden">{r.status}{r.simulated ? ' · sim' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ─── Cycle log ───────────────────────────────────────────────────
function CycleLog({ audit }: { audit: AuditEntry[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const list = [...audit].reverse().slice(0, 40)
  return (
    <Panel title="Cycle log" aside={<span className="num text-[11px] text-dim">{audit.length} cycles</span>}>
      {list.length === 0 ? (
        <p className="text-[14px] text-dim">The audit log is empty.</p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {list.map((e) => {
            const end = e.events.find((x) => x.type === 'cycle_end')?.detail ?? `${e.events.length} events`
            const bad = e.events.some((x) => x.type === 'halted' || x.type === 'cycle_error')
            const isOpen = open === e.cycleId
            return (
              <li key={e.cycleId}>
                <button onClick={() => setOpen(isOpen ? null : e.cycleId)} className="flex w-full items-center gap-3 py-2.5 text-left text-[13px] hover:text-fg">
                  <span className="num w-[130px] shrink-0 text-[11px] text-faint">{stamp(e.receivedAt)}</span>
                  <span className={`flex-1 ${bad ? 'text-loss' : 'text-fg/85'}`}>{end}</span>
                  <ChevronDown size={14} className={`shrink-0 text-dim transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="pb-3 pl-1"><Dispatch events={e.events} animate={false} /></div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ─── Policy ──────────────────────────────────────────────────────
function PolicyPanel({ policy, onSaved }: { policy?: Policy; onSaved: () => void }) {
  const toast = useToast()
  const [draft, setDraft] = useState<Policy | null>(null)
  const [nums, setNums] = useState({ max_bet: '', max_daily_loss: '', stop: '' })
  const dirty = draft !== null
  const p = draft ?? policy

  useEffect(() => {
    if (!dirty && policy) setNums({ max_bet: String(policy.max_bet), max_daily_loss: String(policy.max_daily_loss), stop: String(+(policy.stop_loss_pct * 100).toFixed(4)) })
  }, [policy, dirty])

  if (!p) return <Panel title="Policy"><p className="text-[14px] text-dim">Waiting for the control API.</p></Panel>
  const edit = (fn: (d: Policy) => void) => {
    const d = structuredClone(draft ?? p)
    fn(d)
    setDraft(d)
  }
  const toggle = (list: string[], v: string) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v) }

  const save = async () => {
    try {
      await api('/api/policy', {
        max_bet: Number(nums.max_bet), max_daily_loss: Number(nums.max_daily_loss), stop_loss_pct: Number(nums.stop) / 100,
        venues_enabled: p.venues_enabled, category_deny: p.category_deny, category_allow: p.category_allow,
      })
      setDraft(null)
      toast('Policy saved. The next cycle uses it.')
      onSaved()
    } catch (e) { toast((e as Error).message, true) }
  }
  const setNum = (k: keyof typeof nums) => (v: string) => { setNums({ ...nums, [k]: v }); if (!draft) setDraft(structuredClone(p)) }

  return (
    <Panel title="Policy" aside={dirty && <span className="num text-[11px] text-warn">unsaved</span>}>
      <Field label="Max bet per order" suffix="$" value={nums.max_bet} onChange={setNum('max_bet')} />
      <Field label="Max daily loss" suffix="$" value={nums.max_daily_loss} onChange={setNum('max_daily_loss')} />
      <Field label="Stop-loss from peak" suffix="%" value={nums.stop} onChange={setNum('stop')} />
      <p className="label mt-5 mb-2">Venues</p>
      <div className="flex flex-wrap gap-1.5">
        {VENUES.map((v) => <Chip key={v} on={p.venues_enabled.includes(v)} onClick={() => edit((d) => toggle(d.venues_enabled, v))}>{v}</Chip>)}
      </div>
      <p className="label mt-5 mb-2">Denied</p>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => <Chip key={c} kind="deny" on={p.category_deny.includes(c)} onClick={() => edit((d) => toggle(d.category_deny, c))}>{c}</Chip>)}
      </div>
      <p className="label mt-5 mb-2">Only allow <span className="normal-case tracking-normal text-faint">(none = all)</span></p>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => <Chip key={c} on={p.category_allow.includes(c)} onClick={() => edit((d) => toggle(d.category_allow, c))}>{c}</Chip>)}
      </div>
      <div className="mt-5 flex gap-2">
        <button disabled={!dirty} onClick={save} className={`${btn} !border-acid/50 !text-acid`}>Save policy</button>
        {dirty && <button onClick={() => setDraft(null)} className="px-2 text-[12px] text-dim hover:text-fg">Discard</button>}
      </div>
    </Panel>
  )
}

// ─── Strategy ────────────────────────────────────────────────────
type StratForm = Record<'minEdge' | 'minConfidence' | 'stake' | 'maxIntents' | 'minLiquidity' | 'minPrice' | 'maxPrice' | 'cap', string>

function StrategyPanel({ status, onSaved }: { status: Status | null; onSaved: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState<StratForm | null>(null)
  const st = status?.settings
  const fromSettings = (): StratForm | null => st ? {
    minEdge: String(+(st.strategy.minEdge * 100).toFixed(4)), minConfidence: String(+(st.strategy.minConfidence * 100).toFixed(4)),
    stake: String(st.strategy.stake), maxIntents: String(st.strategy.maxIntents), minLiquidity: String(st.strategy.minLiquidity),
    minPrice: String(+(st.strategy.minPrice * 100).toFixed(4)), maxPrice: String(+(st.strategy.maxPrice * 100).toFixed(4)),
    cap: String(st.maxDataPaymentLovelace / 1e6),
  } : null
  const f = form ?? fromSettings()
  if (!f) return null
  const set = (k: keyof StratForm) => (v: string) => setForm({ ...f, [k]: v })

  const save = async (reset = false) => {
    try {
      await api('/api/settings', reset ? { reset: true } : {
        strategy: {
          minEdge: Number(f.minEdge) / 100, minConfidence: Number(f.minConfidence) / 100, stake: Number(f.stake),
          maxIntents: Number(f.maxIntents), minLiquidity: Number(f.minLiquidity), minPrice: Number(f.minPrice) / 100, maxPrice: Number(f.maxPrice) / 100,
        },
        maxDataPaymentLovelace: Math.round(Number(f.cap) * 1e6),
      })
      setForm(null)
      toast(reset ? 'Strategy reset to the repo defaults.' : 'Strategy saved. The next cycle uses it.')
      onSaved()
    } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <Panel title="Strategy" aside={<span className="num text-[11px] text-dim">edge vs signal</span>}>
      <Field label="Minimum edge" suffix="¢" value={f.minEdge} onChange={set('minEdge')} />
      <Field label="Minimum confidence" suffix="%" value={f.minConfidence} onChange={set('minConfidence')} />
      <Field label="Stake per order" suffix="$" value={f.stake} onChange={set('stake')} />
      <Field label="Orders per cycle" value={f.maxIntents} onChange={set('maxIntents')} step="1" />
      <Field label="Minimum liquidity" value={f.minLiquidity} onChange={set('minLiquidity')} />
      <Field label="Lowest price" suffix="¢" value={f.minPrice} onChange={set('minPrice')} />
      <Field label="Highest price" suffix="¢" value={f.maxPrice} onChange={set('maxPrice')} />
      <Field label="Data payment cap" suffix="₳" value={f.cap} onChange={set('cap')} />
      <div className="mt-5 flex gap-2">
        <button disabled={!form} onClick={() => save()} className={`${btn} !border-acid/50 !text-acid`}>Save strategy</button>
        <button onClick={() => save(true)} className="px-2 text-[12px] text-dim hover:text-fg">Repo defaults</button>
      </div>
    </Panel>
  )
}

// ─── Stress test ─────────────────────────────────────────────────
function StressPanel({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [pnl, setPnl] = useState('-250')
  const shock = async () => {
    try {
      await api('/api/shock', { pnl: Number(pnl) })
      toast(`Booked a ${signed(Number(pnl))} shock.`, Number(pnl) < 0)
      onDone()
    } catch (e) { toast((e as Error).message, true) }
  }
  const reset = async () => {
    try {
      await api('/api/reset', {})
      toast('Book reset to $1,000. Policy and order history are kept.')
      onDone()
    } catch (e) { toast((e as Error).message, true) }
  }
  return (
    <Panel title="Stress test" tint="rgba(255, 107, 122, 0.08)">
      <Field label="P&L shock" suffix="$" value={pnl} onChange={setPnl} />
      <p className="mt-2 text-[12px] text-dim">−250 trips the daily loss limit and the stop-loss under the default policy.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={shock} className={btn}>Apply shock</button>
        <ArmButton className={`${btn} !border-loss/40 !text-loss`} armedLabel="Clear the book?" onConfirm={reset}>Reset book</ArmButton>
      </div>
    </Panel>
  )
}

// ─── Backend ─────────────────────────────────────────────────────
function BackendPanel({ status, onChange }: { status: Status | null; onChange: () => void }) {
  const toast = useToast()
  const [showLog, setShowLog] = useState(false)
  const svc: [keyof Status['services'], string, number][] = [['control', 'Control API', 8787], ['cardano', 'Cardano payments', 8788], ['score', 'Score provider', 8789], ['feed', 'Market feed', 8790]]
  const call = async (what: 'start' | 'stop') => {
    try { toast(`Backend ${(await api<{ result: string }>(`/api/backend/${what}`, {})).result}.`) } catch (e) { toast((e as Error).message, true) }
    onChange()
  }
  const allUp = status ? Object.values(status.services).every(Boolean) : false
  return (
    <Panel title="Backend">
      <ul className="space-y-1.5">
        {svc.map(([k, name, port]) => (
          <li key={k} className="flex items-center justify-between text-[13px]">
            <span className="text-dim">{name} <span className="num text-[11px] text-faint">:{port}</span></span>
            <span className={`num text-[11px] ${status?.services[k] ? 'text-acid' : 'text-loss'}`}>{status?.services[k] ? 'running' : 'down'}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => call('start')} disabled={allUp} className={btn}>Start</button>
        <ArmButton onConfirm={() => call('stop')} disabled={!status?.managed} armedLabel="Stop all four?" className={btn}>Stop</ArmButton>
        <button onClick={() => setShowLog(!showLog)} className="ml-auto text-[12px] text-dim hover:text-fg">{showLog ? 'Hide' : 'Show'} output</button>
      </div>
      {showLog && (
        <pre className="num mt-3 max-h-56 overflow-auto rounded-xl bg-black/40 p-3 text-[10.5px] leading-relaxed text-dim scroll-thin">
          {status?.logs.join('\n') || 'No output yet.'}
        </pre>
      )}
    </Panel>
  )
}
