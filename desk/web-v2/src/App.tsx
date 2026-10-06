import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Activity as ActivityIcon, ArrowUpRight, ChevronDown, Coins, Home as HomeIcon, LineChart, OctagonX, Play, Power, Repeat,
  Search, Server, SlidersHorizontal, Sparkles, Zap,
} from 'lucide-react'
import MeshGradient from '@/v2/MeshGradient'
import ClickSpark from '@/components/ClickSpark'
import Magnet from '@/components/Magnet'
import BlurText from '@/components/BlurText'
import {
  api, cents, compact, signed, venueName, usePoll,
  type AgentState, type AuditEntry, type Cycle, type FeedStatus, type Market, type Policy, type Receipt, type Status, type Wallet,
} from '@/api'
import {
  ArmButton, Balance, Card, Chip, Flow, Glass, Group, NoteHost, NumInput, Refract, Ring, Row, Segmented, Toggle, VenueMark,
  pill, pillWhite, useNote, useNotify,
} from '@/v2/kit'
import { Events, Stepper } from '@/v2/cycle'

const CATEGORIES = ['politics', 'sports', 'crypto', 'economy', 'tech', 'culture', 'science', 'weather', 'other']
const VENUES = ['polymarket', 'kalshi'] as const
type Tab = 'home' | 'markets' | 'activity' | 'controls'
const TABS: [Tab, string, typeof HomeIcon][] = [
  ['home', 'Home', HomeIcon], ['markets', 'Markets', LineChart], ['activity', 'Activity', ActivityIcon], ['controls', 'Controls', SlidersHorizontal],
]

export default function App() {
  return (
    <NoteHost>
      <Desk />
    </NoteHost>
  )
}

function useTab(): [Tab, (t: Tab) => void] {
  const read = () => (TABS.some(([t]) => `#${t}` === location.hash) ? location.hash.slice(1) : 'home') as Tab
  const [tab, setTab] = useState<Tab>(read)
  useEffect(() => {
    const on = () => setTab(read())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return [tab, (t) => { location.hash = t; window.scrollTo({ top: 0, behavior: 'smooth' }) }]
}

function Desk() {
  const status = usePoll<Status>('/api/status', 1500)
  const state = usePoll<AgentState>('/api/state', 2000)
  const markets = usePoll<Market[]>('/api/markets', 12000)
  const feed = usePoll<FeedStatus[]>('/api/feed', 12000)
  const receipts = usePoll<Receipt[]>('/api/receipts', 5000)
  const wallet = usePoll<Wallet>('/api/wallet', 15000)
  const audit = usePoll<AuditEntry[]>('/api/audit', 5000)
  const notify = useNotify()
  const [tab, setTab] = useTab()
  const [running, setRunning] = useState(false)

  const s = status.data
  const st = state.data
  const busy = running || Boolean(s?.auto.running)
  const halted = Boolean(st?.halt.halted)

  const lastCycle: Cycle | null = useMemo(() => {
    if (s?.cycles?.[0]) return s.cycles[0]
    const a = audit.data?.at(-1)
    if (!a) return null
    const end = a.events.find((e) => e.type === 'cycle_end')
    return { cycleId: a.cycleId, startedAt: a.receivedAt, finishedAt: a.receivedAt, summary: end?.detail ?? '', events: a.events }
  }, [s, audit.data])

  const refreshAll = () => Promise.all([status.refresh(), state.refresh(), markets.refresh(), receipts.refresh(), audit.refresh(), wallet.refresh()])

  const runCycle = async () => {
    if (busy) return
    setRunning(true)
    try {
      const r = await api<Cycle>('/api/cycle', {})
      notify(r.summary, r.summary.startsWith('halted') || r.summary === 'cycle failed')
    } catch (e) {
      notify((e as Error).message, true)
    }
    await refreshAll()
    setRunning(false)
  }

  const setKill = async () => {
    const on = !st?.policy.kill_switch
    try {
      await api('/api/policy', { kill_switch: on })
      notify(on ? 'Kill switch on. The next cycle halts.' : 'Kill switch off. The agent may trade.', on)
      state.refresh()
    } catch (e) { notify((e as Error).message, true) }
  }

  const setAuto = async (enabled: boolean, seconds = s?.auto.seconds ?? 60) => {
    try {
      await api('/api/auto', { enabled, seconds })
      notify(enabled ? `Auto-run on, every ${seconds}s.` : 'Auto-run off.')
      status.refresh()
    } catch (e) { notify((e as Error).message, true) }
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Backdrop halted={halted} />
      <Nav tab={tab} setTab={setTab} status={s} />
      <Island running={busy} halted={halted} reasons={st?.halt.reasons ?? []} status={s} />

      <main className="mx-auto max-w-[1180px] px-4 pb-28 pt-[132px] sm:px-6">
        {/* No filter on this wrapper: a filtered ancestor breaks backdrop-filter glass inside it. */}
        <div key={tab} className="tab-in">
            {tab === 'home' && (
              <Home
                state={st} status={s} busy={busy} cycle={lastCycle} markets={markets.data ?? []} receipts={receipts.data ?? []} audit={audit.data ?? []}
                onRun={runCycle} onKill={setKill} onAuto={() => setAuto(!s?.auto.enabled)} goto={setTab} onChange={refreshAll}
              />
            )}
            {tab === 'markets' && <MarketsView markets={markets.data ?? []} feed={feed.data ?? []} />}
            {tab === 'activity' && <ActivityView audit={audit.data ?? []} receipts={receipts.data ?? []} wallet={wallet.data} />}
            {tab === 'controls' && (
              <ControlsView
                state={st} status={s} onAuto={setAuto} onKill={setKill}
                onPolicy={() => { state.refresh(); markets.refresh() }} onStrategy={() => { status.refresh(); markets.refresh() }} onChange={refreshAll}
              />
            )}
        </div>
      </main>
    </div>
  )
}

// ─── Background: animated mesh gradient, turns red when halted ────────────
function Backdrop({ halted }: { halted: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10">
      <MeshGradient colors={halted ? ['#ff2d55', '#7a0c2e', '#14040a'] : ['#7d00ff', '#2a46ff', '#08061a']} />
      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_10%,transparent_0%,rgb(7_6_15/.35)_55%,rgb(7_6_15/.85)_100%)]" />
    </div>
  )
}

// ─── Floating glass nav ───────────────────────────────────────────
function Nav({ tab, setTab, status }: { tab: Tab; setTab: (t: Tab) => void; status: Status | null }) {
  const up = status ? Object.values(status.services).filter(Boolean).length : 0
  return (
    <div className="fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <Refract height={60} width="min(760px, 100%)" radius={30} tint={0.42} contentClassName="flex h-full w-full items-center justify-between gap-2 px-2.5">
        <span className="flex items-center gap-2.5 pl-1">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-violet to-[#3b4bff] text-white shadow-[inset_0_1px_1px_rgb(255_255_255/.5),0_6px_18px_-6px_#7d00ff]">
            <Zap size={16} strokeWidth={2.6} />
          </span>
          <span className="hidden text-[15px] font-bold tracking-tight sm:inline">Agent Desk</span>
        </span>
        <nav className="flex items-center gap-0.5">
          {TABS.map(([t, label, Icon]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-semibold transition-colors sm:px-3.5 ${tab === t ? 'text-ink' : 'text-dim hover:text-fg'}`}
            >
              {tab === t && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-white shadow-[0_4px_14px_rgb(0_0_0/.3)]" transition={{ type: 'spring', stiffness: 480, damping: 36 }} />}
              <Icon size={15} className="relative" strokeWidth={2.3} />
              <span className="relative max-md:hidden">{label}</span>
            </button>
          ))}
        </nav>
        <span className="flex items-center gap-2 pr-2 text-[12px] font-semibold">
          <span className={`hidden sm:inline ${up === 4 ? 'text-dim' : 'text-loss'}`}>{status ? `${up}/4 live` : 'offline'}</span>
        </span>
      </Refract>
    </div>
  )
}

// ─── Dynamic island: running, halted, auto-run, messages ─────────
function Island({ running, halted, reasons, status }: { running: boolean; halted: boolean; reasons: string[]; status: Status | null }) {
  const note = useNote()
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [])

  let content: ReactNode = null
  let key = 'none'
  let tone = ''
  if (note) {
    key = `note-${note.id}`
    tone = note.bad ? 'text-loss' : ''
    content = <><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${note.bad ? 'bg-loss/25' : 'bg-acid/25'}`}>{note.bad ? <OctagonX size={14} className="text-loss" /> : <Sparkles size={14} className="text-acid" />}</span><span className="line-clamp-2 text-[13px] font-semibold">{note.text}</span></>
  } else if (running) {
    key = 'running'
    content = <><span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-white" /><span className="shimmer text-[13px] font-semibold">Running a cycle</span></>
  } else if (halted) {
    key = 'halted'
    tone = 'text-loss'
    content = <><OctagonX size={16} className="shrink-0" /><span className="text-[13px] font-semibold">Trading halted<span className="font-medium text-loss/75"> · {reasons.join(', ').replace(/_/g, ' ')}</span></span></>
  } else if (status?.auto.enabled) {
    key = 'auto'
    content = <><Repeat size={14} className="shrink-0 text-acid" /><span className="num text-[13px] font-semibold">Next cycle in {Math.max(0, Math.round((status.auto.nextAt - Date.now()) / 1000))}s</span></>
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[86px] z-30 flex justify-center px-4">
      <AnimatePresence mode="popLayout">
        {content && (
          <motion.div
            key={key.startsWith('note') ? 'note' : key}
            layout
            initial={{ opacity: 0, scale: 0.6, y: -14, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.7, y: -10, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className={`pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2.5 rounded-full bg-black/55 py-2 pl-2.5 pr-4 shadow-[inset_0_1px_0_rgb(255_255_255/.22),inset_0_0_0_1px_rgb(255_255_255/.08),0_18px_40px_-14px_rgb(0_0_0/.8)] backdrop-blur-2xl ${tone}`}
          >
            <motion.span key={key} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex min-w-0 items-center gap-2.5">{content}</motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Home ────────────────────────────────────────────────────────
function Home({ state, status, busy, cycle, markets, receipts, audit, onRun, onKill, onAuto, goto, onChange }: {
  state: AgentState | null; status: Status | null; busy: boolean; cycle: Cycle | null; markets: Market[]; receipts: Receipt[]; audit: AuditEntry[]
  onRun: () => void; onKill: () => void; onAuto: () => void; goto: (t: Tab) => void; onChange: () => void
}) {
  const p = state?.portfolio
  const pol = state?.policy
  const dayPct = p && p.startOfDayEquity > 0 ? (p.dailyPnl / p.startOfDayEquity) * 100 : 0
  const spent = receipts.reduce((sum, r) => sum + r.amount, 0) / 1e6

  return (
    <div className="space-y-5">
      {/* Balance */}
      <section className="flex flex-col items-center pb-4 pt-6 text-center">
        <p className="lg-soft rounded-full px-3 py-1 text-[12px] font-semibold text-dim">Paper book · USD</p>
        <div className="mt-4 text-[clamp(56px,11vw,112px)] font-bold leading-none tracking-[-0.045em]">
          {p ? <Balance value={p.equity} centsClassName="text-[0.42em] tracking-[-0.02em] text-fg/70" /> : <span className="text-faint">$–</span>}
        </div>
        {p && (
          <p className={`mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-bold ${p.dailyPnl > 0.004 ? 'bg-acid/15 text-acid' : p.dailyPnl < -0.004 ? 'bg-loss/15 text-loss' : 'bg-white/10 text-dim'}`}>
            <ArrowUpRight size={14} strokeWidth={2.6} className={p.dailyPnl < -0.004 ? 'rotate-90' : ''} />
            <Flow value={p.dailyPnl} signed /> <span className="opacity-70">({dayPct >= 0 ? '+' : '−'}{Math.abs(dayPct).toFixed(2)}%) today</span>
          </p>
        )}

        <div className="mt-9 flex items-start justify-center gap-5 sm:gap-8">
          <ClickSpark sparkColor="#ffffff" sparkCount={12} sparkRadius={34} sparkSize={12}>
            <Magnet padding={50} magnetStrength={5}>
              <Action label={busy ? 'Running' : 'Run cycle'} sub="1 ADA" onClick={onRun} disabled={busy || !status?.services.control} primary>
                {busy ? <span className="h-5 w-5 animate-spin rounded-full border-[2.5px] border-ink/20 border-t-ink" /> : <Play size={22} fill="currentColor" strokeWidth={0} className="ml-0.5" />}
              </Action>
            </Magnet>
          </ClickSpark>
          <Action label="Auto-run" sub={status?.auto.enabled ? `every ${status.auto.seconds}s` : 'off'} onClick={onAuto} active={status?.auto.enabled}>
            <Repeat size={21} strokeWidth={2.3} />
          </Action>
          <Action label="Kill switch" sub={pol?.kill_switch ? 'on' : 'off'} onClick={onKill} danger={pol?.kill_switch}>
            <Power size={21} strokeWidth={2.3} />
          </Action>
          <Action label="Controls" sub="policy" onClick={() => goto('controls')}>
            <SlidersHorizontal size={21} strokeWidth={2.3} />
          </Action>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Cash" icon={<Coins size={15} />}>{p ? <Flow value={p.cash} /> : '–'}</Stat>
        <Stat label="Unrealized" icon={<LineChart size={15} />} tone={p?.unrealizedPnl}>{p ? <Flow value={p.unrealizedPnl} signed /> : '–'}</Stat>
        <Stat label="Realized" icon={<Sparkles size={15} />} tone={p?.realizedPnl}>{p ? <Flow value={p.realizedPnl} signed /> : '–'}</Stat>
        <Stat label="Data spent" icon={<Zap size={15} />}><Flow value={spent} prefix="" suffix=" ADA" decimals={0} /></Stat>
      </section>

      {/* Cycle + risk */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <LastCycle cycle={cycle} running={busy} />
        <Risk state={state} />
      </section>

      <Positions state={state} markets={markets} onChange={onChange} />
      <Recent audit={audit} receipts={receipts} goto={goto} />
    </div>
  )
}

function Action({ children, label, sub, onClick, disabled, primary, active, danger }: {
  children: ReactNode; label: string; sub?: string; onClick: () => void; disabled?: boolean; primary?: boolean; active?: boolean; danger?: boolean
}) {
  const solid = primary ? 'bg-white text-ink shadow-[0_10px_30px_-6px_rgb(255_255_255/.45)]'
    : danger ? 'bg-loss text-white shadow-[0_10px_30px_-6px_rgb(255_92_122/.7)]'
      : active ? 'bg-acid text-ink shadow-[0_10px_30px_-6px_rgb(62_230_168/.6)]' : null
  const body = solid ? (
    <span className={`grid h-[64px] w-[64px] place-items-center rounded-full ${solid} ring-1 ring-white/30 ring-inset`}>{children}</span>
  ) : (
    <Refract width={64} height={64} radius={32} tint={0.22} contentClassName="grid h-full w-full place-items-center">
      {children}
    </Refract>
  )
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="group flex w-[76px] flex-col items-center gap-2 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-60">
      <span className="isolate transition-transform duration-300 group-hover:-translate-y-0.5">{body}</span>
      <span className="text-[13px] font-semibold leading-tight">{label}</span>
      {sub && <span className="-mt-1.5 text-[11px] font-medium text-dim">{sub}</span>}
    </button>
  )
}

function Stat({ label, icon, children, tone }: { label: string; icon: ReactNode; children: ReactNode; tone?: number }) {
  const color = tone === undefined ? 'text-fg' : tone > 0.004 ? 'text-acid' : tone < -0.004 ? 'text-loss' : 'text-fg'
  return (
    <Glass className="p-4 sm:p-5">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-dim">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-fg">{icon}</span>
        {label}
      </p>
      <p className={`num mt-3 text-[22px] font-bold tracking-tight sm:text-[26px] ${color}`}>{children}</p>
    </Glass>
  )
}

function LastCycle({ cycle, running }: { cycle: Cycle | null; running: boolean }) {
  const [open, setOpen] = useState(false)
  const end = cycle?.events.find((e) => e.type === 'cycle_end')?.detail ?? cycle?.summary
  return (
    <Card title="Last cycle" aside={cycle && <span className="text-[12px] font-medium text-dim">{when(cycle.finishedAt)}</span>}>
      <Stepper events={cycle?.events ?? []} running={running} />
      <div className="mt-6">
        {cycle ? (
          <>
            <BlurText key={cycle.cycleId} text={end ?? ''} animateBy="words" delay={50} className="text-[20px] font-bold leading-snug tracking-tight sm:text-[22px]" />
            <button onClick={() => setOpen(!open)} className={`${pill} mt-4`}>
              {open ? 'Hide' : 'Show'} {cycle.events.length - 2} steps <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="mt-3 max-h-[420px] overflow-y-auto pr-1 scroll-thin"><Events events={cycle.events} /></div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          <p className="text-[15px] text-dim">No cycle yet. Press <span className="font-semibold text-fg">Run cycle</span> to read the markets, buy scores and place paper orders.</p>
        )}
      </div>
    </Card>
  )
}

function Risk({ state }: { state: AgentState | null }) {
  const p = state?.portfolio
  const pol = state?.policy
  const used = p ? Math.max(0, -p.dailyPnl) : 0
  const dailyFrac = p && pol ? (pol.max_daily_loss > 0 ? Math.min(1, used / pol.max_daily_loss) : 1) : 0
  const floor = p && pol ? p.highWaterMark * (1 - pol.stop_loss_pct) : 0
  const stopFrac = p && pol ? Math.min(1, Math.max(0, (p.highWaterMark - p.equity) / Math.max(1e-9, p.highWaterMark - floor))) : 0
  const color = (f: number) => (f >= 0.75 ? '#ff5c7a' : f >= 0.4 ? '#ffc85c' : '#3ee6a8')
  return (
    <Card title="Risk" aside={state && <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${state.halt.halted ? 'bg-loss/20 text-loss' : 'bg-acid/15 text-acid'}`}>{state.halt.halted ? 'Halted' : 'Clear to trade'}</span>}>
      <div className="grid grid-cols-2 gap-3">
        {[
          ['Daily loss', dailyFrac, pol ? `$${used.toFixed(0)} of $${pol.max_daily_loss}` : '–'],
          ['To stop-loss', stopFrac, p ? `$${Math.max(0, p.equity - floor).toFixed(0)} left` : '–'],
        ].map(([label, f, text]) => (
          <div key={label as string} className="flex flex-col items-center rounded-[22px] bg-white/[0.03] px-2 py-4 text-center">
            <Ring frac={f as number} color={color(f as number)}>
              <span className="num text-[18px] font-bold">{Math.round((f as number) * 100)}%</span>
            </Ring>
            <p className="mt-3 text-[13px] font-semibold">{label as string}</p>
            <p className="num mt-0.5 text-[12px] text-dim">{text as string}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-dim">
        {state?.halt.halted
          ? `Halted: ${state.halt.reasons.join(', ').replace(/_/g, ' ')}. Cycles skip data and orders until this clears.`
          : 'Either ring reaching 100% halts the agent before it spends anything.'}
      </p>
    </Card>
  )
}

function Positions({ state, markets, onChange }: { state: AgentState | null; markets: Market[]; onChange: () => void }) {
  const notify = useNotify()
  const [open, setOpen] = useState<string | null>(null)
  const names = useMemo(() => new Map(markets.map((m) => [`${m.venue}:${m.marketId}`, m.question])), [markets])
  const rows = state?.portfolio.positions ?? []

  const close = async (venue: string, marketId: string, side: string) => {
    try {
      const r = await api<{ size: number; price: number; realizedPnl: number }>('/api/close', { idempotencyKey: `desk-close-${crypto.randomUUID()}`, venue, marketId, side })
      notify(`Sold ${r.size} ${side.toUpperCase()} at ${cents(r.price)}. Realized ${signed(r.realizedPnl)}.`)
      setOpen(null)
      onChange()
    } catch (e) { notify((e as Error).message, true) }
  }
  const settle = async (venue: string, marketId: string, outcome: string) => {
    try {
      const r = await api<{ realizedPnl: number }>('/api/resolve', { idempotencyKey: `desk-resolve-${crypto.randomUUID()}`, venue, marketId, outcome })
      notify(`Settled as ${outcome}. Realized ${signed(r.realizedPnl)}.`)
      setOpen(null)
      onChange()
    } catch (e) { notify((e as Error).message, true) }
  }

  return (
    <Card title="Positions" aside={<span className="text-[13px] font-semibold text-dim">{rows.length} open</span>}>
      {rows.length === 0 ? (
        <p className="py-2 text-[14px] text-dim">The book holds no positions. A cycle opens them when it finds an edge.</p>
      ) : (
        <ul className="-mx-2 space-y-1">
          <AnimatePresence initial={false}>
            {rows.map((p) => {
              const id = `${p.venue}:${p.marketId}:${p.side}`
              const isOpen = open === id
              return (
                <motion.li key={id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }} className={`rounded-[20px] transition-colors ${isOpen ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}>
                  <button onClick={() => setOpen(isOpen ? null : id)} className="flex w-full items-center gap-3 px-2 py-2.5 text-left">
                    <VenueMark venue={p.venue} />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 text-[14px] font-semibold">{names.get(`${p.venue}:${p.marketId}`) ?? p.marketId}</p>
                      <p className="mt-0.5 text-[12px] text-dim">
                        <span className={`font-bold ${p.side === 'yes' ? 'text-acid' : 'text-loss'}`}>{p.side.toUpperCase()}</span> · {p.size} shares at {cents(p.avgPrice)} · mark {p.markStatus === 'entry' ? 'at entry' : cents(p.markPrice)}{p.markStatus === 'stale' && <span className="text-warn"> (stale)</span>}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-[15px] font-bold"><Flow value={p.marketValue} /></p>
                      <p className={`num text-[12px] font-semibold ${p.unrealizedPnl > 0.004 ? 'text-acid' : p.unrealizedPnl < -0.004 ? 'text-loss' : 'text-dim'}`}><Flow value={p.unrealizedPnl} signed /></p>
                    </div>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pl-[60px]">
                          <ArmButton className={pillWhite} armedLabel="Sell at bid?" onConfirm={() => close(p.venue, p.marketId, p.side)}>Close position</ArmButton>
                          <span className="mx-1 text-[12px] text-faint">or settle</span>
                          {(['yes', 'no', 'void'] as const).map((o) => (
                            <button key={o} className={pill} onClick={() => settle(p.venue, p.marketId, o)}>{o === 'void' ? 'Void' : `${o.toUpperCase()} won`}</button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  )
}

type Item = { id: string; at: string; kind: 'cycle' | 'payment'; title: string; sub: string; amount?: string; bad?: boolean }

function activityItems(audit: AuditEntry[], receipts: Receipt[]): Item[] {
  const items: Item[] = [
    ...audit.map((e) => {
      const end = e.events.find((x) => x.type === 'cycle_end')?.detail ?? `${e.events.length} events`
      const bad = e.events.some((x) => x.type === 'halted' || x.type === 'cycle_error')
      const fills = e.events.filter((x) => x.type === 'fill_filled').length
      return { id: e.cycleId, at: e.receivedAt, kind: 'cycle' as const, title: end, sub: `Agent cycle · ${clockOf(e.receivedAt)}`, amount: fills ? `${fills} fill${fills > 1 ? 's' : ''}` : undefined, bad }
    }),
    ...receipts.map((r) => ({ id: r.receiptId, at: r.createdAt, kind: 'payment' as const, title: 'Score provider', sub: `x402 data payment · ${clockOf(r.createdAt)}`, amount: `−${(r.amount / 1e6).toLocaleString('en-US')} ADA` })),
  ]
  return items.sort((a, b) => b.at.localeCompare(a.at))
}

function ActivityList({ items }: { items: Item[] }) {
  const groups: [string, Item[]][] = []
  for (const it of items) {
    const d = dayOf(it.at)
    const g = groups.at(-1)
    if (g && g[0] === d) g[1].push(it)
    else groups.push([d, [it]])
  }
  return (
    <div className="space-y-4">
      {groups.map(([day, list]) => (
        <div key={day}>
          <p className="mb-1 px-2 text-[12px] font-bold text-dim">{day}</p>
          <ul>
            {list.map((it) => (
              <li key={it.id} className="flex items-center gap-3 rounded-[18px] px-2 py-2.5 transition-colors hover:bg-white/[0.04]">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${it.kind === 'payment' ? 'bg-warn/20 text-warn' : it.bad ? 'bg-loss/20 text-loss' : 'bg-violet/25 text-violet'}`}>
                  {it.kind === 'payment' ? <Coins size={17} /> : it.bad ? <OctagonX size={17} /> : <Zap size={17} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`line-clamp-1 text-[14px] font-semibold ${it.bad ? 'text-loss' : ''}`}>{it.title}</p>
                  <p className="mt-0.5 text-[12px] text-dim">{it.sub}</p>
                </div>
                {it.amount && <span className={`num shrink-0 text-[14px] font-bold ${it.kind === 'payment' ? 'text-fg' : 'text-acid'}`}>{it.amount}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function Recent({ audit, receipts, goto }: { audit: AuditEntry[]; receipts: Receipt[]; goto: (t: Tab) => void }) {
  const items = activityItems(audit, receipts)
  return (
    <Card title="Recent activity" aside={items.length > 0 && <button onClick={() => goto('activity')} className="text-[13px] font-semibold text-violet hover:text-fg">See all</button>}>
      {items.length === 0 ? <p className="py-2 text-[14px] text-dim">Nothing yet. Cycles and data payments show up here.</p> : <ActivityList items={items.slice(0, 6)} />}
    </Card>
  )
}

// ─── Markets ─────────────────────────────────────────────────────
function MarketsView({ markets, feed }: { markets: Market[]; feed: FeedStatus[] }) {
  const [venue, setVenue] = useState<'all' | 'polymarket' | 'kalshi'>('all')
  const [filter, setFilter] = useState<'all' | 'eligible'>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(30)
  const order = (m: Market) => (m.eligible ? 0 : m.held ? 1 : m.blocked.length ? 3 : 2)
  const list = markets
    .filter((m) => (venue === 'all' || m.venue === venue) && (filter === 'all' || m.eligible) && (!q || m.question.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => order(a) - order(b) || b.liquidity - a.liquidity)
  const eligible = markets.filter((m) => m.eligible).length

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[40px] font-bold leading-none tracking-[-0.035em] sm:text-[52px]">Markets</h1>
          <p className="mt-3 text-[14px] text-dim">
            <span className="font-bold text-acid">{eligible} eligible</span> of {markets.length} live markets. A cycle pays to score the eligible ones.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {feed.map((f) => (
            <span key={f.venue} className="lg-soft flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold">
              {venueName(f.venue)} <span className="num text-dim">{f.markets} · {f.ageSeconds ?? '–'}s ago</span>{f.stale && <span className="text-warn">stale</span>}
            </span>
          ))}
        </div>
      </header>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Segmented id="venue" value={venue} onChange={setVenue} options={[['all', 'All venues'], ['polymarket', 'Polymarket'], ['kalshi', 'Kalshi']]} />
        <Segmented id="filter" value={filter} onChange={setFilter} options={[['all', 'All'], ['eligible', 'Eligible']]} />
        <label className="lg-soft flex flex-1 items-center gap-2 rounded-full px-4 py-2">
          <Search size={15} className="text-dim" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" className="w-full bg-transparent text-[14px] font-medium outline-none placeholder:text-faint" />
        </label>
      </div>

      <Card>
        {markets.length === 0 ? (
          <p className="py-2 text-[14px] text-dim">The market feed has no data yet. It polls every 30 seconds.</p>
        ) : list.length === 0 ? (
          <p className="py-2 text-[14px] text-dim">No markets match.</p>
        ) : (
          <ul className="-mx-2">
            {list.slice(0, limit).map((m) => {
              const yes = Math.round(Math.max(0, Math.min(1, m.yesPrice)) * 100)
              const tag = m.held ? ['Held', 'bg-white/10 text-fg'] : m.blocked.length ? [m.blocked.join(', '), 'bg-loss/15 text-loss'] : m.eligible ? ['Eligible', 'bg-acid/15 text-acid'] : ['Outside strategy', 'bg-white/[0.05] text-faint']
              return (
                <li key={`${m.venue}:${m.marketId}`} className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-[18px] px-2 py-3 transition-colors hover:bg-white/[0.04] md:grid-cols-[40px_minmax(0,1fr)_170px_130px]">
                  <VenueMark venue={m.venue} />
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-[14px] font-semibold leading-snug">{m.question}</p>
                    <p className="mt-0.5 text-[12px] capitalize text-dim">
                      {m.category} · ${compact(m.liquidity)} liquidity{m.endDate ? ` · ends ${new Date(m.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                    </p>
                  </div>
                  <div className="max-md:hidden">
                    <div className="flex items-baseline justify-between text-[12px]">
                      <span className="num font-bold">{yes}% yes</span>
                      <span className="num text-dim">{cents(m.bestBid)} / {cents(m.bestAsk)}</span>
                    </div>
                    <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-white/[0.08]">
                      <div className="h-full rounded-full bg-gradient-to-r from-violet to-[#5b7bff]" style={{ width: `${yes}%` }} />
                    </div>
                  </div>
                  <span className={`justify-self-end whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${tag[1]}`}>{tag[0]}</span>
                </li>
              )
            })}
          </ul>
        )}
        {list.length > limit && (
          <button onClick={() => setLimit(limit + 30)} className={`${pill} mt-3`}>Show more ({list.length - limit} left)</button>
        )}
      </Card>
    </div>
  )
}

// ─── Activity ────────────────────────────────────────────────────
function ActivityView({ audit, receipts, wallet }: { audit: AuditEntry[]; receipts: Receipt[]; wallet: Wallet | null }) {
  const [open, setOpen] = useState<string | null>(null)
  const [view, setView] = useState<'all' | 'cycles' | 'payments'>('all')
  const items = activityItems(audit, receipts).filter((i) => view === 'all' || (view === 'cycles' ? i.kind === 'cycle' : i.kind === 'payment'))
  const spent = receipts.reduce((s, r) => s + r.amount, 0) / 1e6
  const cycles = [...audit].reverse().slice(0, 40)

  return (
    <div className="space-y-5">
      <header className="pt-4">
        <h1 className="text-[40px] font-bold leading-none tracking-[-0.035em] sm:text-[52px]">Activity</h1>
        <p className="mt-3 text-[14px] text-dim">{audit.length} cycles and {receipts.length} data payments on record.</p>
      </header>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card title="Timeline" aside={<Segmented id="act" size="sm" value={view} onChange={setView} options={[['all', 'All'], ['cycles', 'Cycles'], ['payments', 'Payments']]} />}>
            {items.length === 0 ? <p className="py-2 text-[14px] text-dim">Nothing on record yet.</p> : <ActivityList items={items.slice(0, 60)} />}
          </Card>
          <Card title="Cycle log" aside={<span className="text-[13px] font-semibold text-dim">open one to see every step</span>}>
            {cycles.length === 0 ? (
              <p className="py-2 text-[14px] text-dim">The audit log is empty.</p>
            ) : (
              <ul className="-mx-2 space-y-1">
                {cycles.map((e) => {
                  const end = e.events.find((x) => x.type === 'cycle_end')?.detail ?? `${e.events.length} events`
                  const bad = e.events.some((x) => x.type === 'halted' || x.type === 'cycle_error')
                  const isOpen = open === e.cycleId
                  return (
                    <li key={e.cycleId} className={`rounded-[18px] ${isOpen ? 'bg-white/[0.05]' : ''}`}>
                      <button onClick={() => setOpen(isOpen ? null : e.cycleId)} className="flex w-full items-center gap-3 rounded-[18px] px-2 py-2.5 text-left hover:bg-white/[0.04]">
                        <span className={`min-w-0 flex-1 text-[14px] font-semibold ${bad ? 'text-loss' : ''}`}>{end}</span>
                        <span className="num shrink-0 text-[12px] text-dim">{when(e.receivedAt)}</span>
                        <ChevronDown size={15} className={`shrink-0 text-dim transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                            <div className="px-1 pb-2"><Events events={e.events} animate={false} /></div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <WalletCard wallet={wallet} spent={spent} payments={receipts.length} />
        </div>
      </section>
    </div>
  )
}

function WalletCard({ wallet, spent, payments }: { wallet: Wallet | null; spent: number; payments: number }) {
  return (
    <div className="relative">
      <div className="absolute -inset-3 -z-10 rounded-[40px] bg-gradient-to-br from-[#7d00ff] via-[#3b4bff] to-[#00c2ff] opacity-50 blur-2xl" />
      <Refract width="100%" height={230} radius={30} tint={0.12} contentClassName="flex h-full w-full flex-col justify-between p-6">
        <div className="flex w-full items-start justify-between">
          <div>
            <p className="text-[13px] font-semibold text-fg/80">Agent wallet</p>
            <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-fg/60">{wallet ? `${wallet.network} · ${wallet.simulated ? 'simulated' : 'live'}` : 'Cardano'}</p>
          </div>
          <span className="text-[26px] font-bold leading-none text-fg/90">₳</span>
        </div>
        <div className="w-full">
          <p className="num text-[34px] font-bold leading-none tracking-tight">
            {wallet && Number.isFinite(wallet.balanceLovelace) ? <Flow value={wallet.balanceLovelace / 1e6} prefix="" suffix=" ADA" decimals={2} /> : <span className="text-fg/50">Balance n/a</span>}
          </p>
          <p className="mono mt-3 truncate text-[11px] text-fg/60">{wallet?.address ?? 'Waiting for the payments service'}</p>
        </div>
      </Refract>
      <Glass className="mt-4 grid grid-cols-2 divide-x divide-white/10 p-4">
        <div className="px-2">
          <p className="label">Spent on data</p>
          <p className="num mt-1 text-[20px] font-bold"><Flow value={spent} prefix="" suffix=" ADA" decimals={0} /></p>
        </div>
        <div className="px-4">
          <p className="label">Payments</p>
          <p className="num mt-1 text-[20px] font-bold">{payments}</p>
        </div>
      </Glass>
    </div>
  )
}

// ─── Controls ────────────────────────────────────────────────────
function ControlsView({ state, status, onAuto, onKill, onPolicy, onStrategy, onChange }: {
  state: AgentState | null; status: Status | null; onAuto: (enabled: boolean, seconds?: number) => void; onKill: () => void
  onPolicy: () => void; onStrategy: () => void; onChange: () => void
}) {
  return (
    <div className="space-y-5">
      <header className="pt-4">
        <h1 className="text-[40px] font-bold leading-none tracking-[-0.035em] sm:text-[52px]">Controls</h1>
        <p className="mt-3 text-[14px] text-dim">Every change applies from the next cycle.</p>
      </header>
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Automation state={state} status={status} onAuto={onAuto} onKill={onKill} />
          <PolicyPanel policy={state?.policy} onSaved={onPolicy} />
        </div>
        <div className="space-y-5">
          <StrategyPanel status={status} onSaved={onStrategy} />
          <StressPanel onDone={onChange} />
          <BackendPanel status={status} />
        </div>
      </section>
    </div>
  )
}

function Automation({ state, status, onAuto, onKill }: { state: AgentState | null; status: Status | null; onAuto: (enabled: boolean, seconds?: number) => void; onKill: () => void }) {
  const [secs, setSecs] = useState<string | null>(null)
  const value = secs ?? String(status?.auto.seconds ?? 60)
  return (
    <Card title="Automation">
      <Group>
        <Row label="Auto-run" hint="Runs a cycle on a timer, from the desk server.">
          <Toggle on={Boolean(status?.auto.enabled)} onClick={() => onAuto(!status?.auto.enabled, Number(value))} />
        </Row>
        <Row label="Interval" hint="10 to 3600 seconds.">
          <span className="flex items-center gap-2">
            <NumInput value={value} onChange={setSecs} suffix="s" width="w-14" step="1" />
            {secs !== null && <button className={pillWhite} onClick={() => { onAuto(Boolean(status?.auto.enabled), Number(secs)); setSecs(null) }}>Set</button>}
          </span>
        </Row>
        <Row label={<span className={state?.policy.kill_switch ? 'text-loss' : ''}>Kill switch</span>} hint="Stops the next cycle before it buys data.">
          <Toggle danger on={Boolean(state?.policy.kill_switch)} onClick={onKill} />
        </Row>
      </Group>
    </Card>
  )
}

function SaveBar({ show, onSave, onDiscard, label }: { show: boolean; onSave: () => void; onDiscard: () => void; label: string }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
          <div className="mt-4 flex items-center justify-between gap-3 rounded-full bg-violet/20 py-1.5 pl-4 pr-1.5 shadow-[inset_0_0_0_1px_rgb(155_107_255/.35)]">
            <span className="text-[13px] font-semibold">Unsaved changes</span>
            <span className="flex gap-1">
              <button onClick={onDiscard} className="rounded-full px-3 py-1.5 text-[13px] font-semibold text-dim hover:text-fg">Discard</button>
              <button onClick={onSave} className={pillWhite}>{label}</button>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function PolicyPanel({ policy, onSaved }: { policy?: Policy; onSaved: () => void }) {
  const notify = useNotify()
  const [draft, setDraft] = useState<Policy | null>(null)
  const [nums, setNums] = useState({ max_bet: '', max_daily_loss: '', stop: '' })
  const dirty = draft !== null
  const p = draft ?? policy

  useEffect(() => {
    if (!dirty && policy) setNums({ max_bet: String(policy.max_bet), max_daily_loss: String(policy.max_daily_loss), stop: String(+(policy.stop_loss_pct * 100).toFixed(4)) })
  }, [policy, dirty])

  if (!p) return <Card title="Policy"><p className="text-[14px] text-dim">Waiting for the control API.</p></Card>
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
      notify('Policy saved. The next cycle uses it.')
      onSaved()
    } catch (e) { notify((e as Error).message, true) }
  }
  const setNum = (k: keyof typeof nums) => (v: string) => { setNums({ ...nums, [k]: v }); if (!draft) setDraft(structuredClone(p)) }

  return (
    <Card title="Policy">
      <Group>
        <Row label="Max bet per order"><NumInput prefix="$" value={nums.max_bet} onChange={setNum('max_bet')} /></Row>
        <Row label="Max daily loss"><NumInput prefix="$" value={nums.max_daily_loss} onChange={setNum('max_daily_loss')} /></Row>
        <Row label="Stop-loss from peak"><NumInput suffix="%" value={nums.stop} onChange={setNum('stop')} /></Row>
      </Group>
      <p className="label mb-2 mt-5 px-1">Venues</p>
      <div className="flex flex-wrap gap-1.5">
        {VENUES.map((v) => <Chip key={v} on={p.venues_enabled.includes(v)} onClick={() => edit((d) => toggle(d.venues_enabled, v))}>{venueName(v)}</Chip>)}
      </div>
      <p className="label mb-2 mt-5 px-1">Denied categories</p>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => <Chip key={c} kind="deny" on={p.category_deny.includes(c)} onClick={() => edit((d) => toggle(d.category_deny, c))}>{c}</Chip>)}
      </div>
      <p className="label mb-2 mt-5 px-1">Only allow <span className="text-faint">(none selected allows all)</span></p>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => <Chip key={c} on={p.category_allow.includes(c)} onClick={() => edit((d) => toggle(d.category_allow, c))}>{c}</Chip>)}
      </div>
      <SaveBar show={dirty} onSave={save} onDiscard={() => setDraft(null)} label="Save policy" />
    </Card>
  )
}

type StratForm = Record<'minEdge' | 'minConfidence' | 'stake' | 'maxIntents' | 'minLiquidity' | 'minPrice' | 'maxPrice' | 'cap', string>

function StrategyPanel({ status, onSaved }: { status: Status | null; onSaved: () => void }) {
  const notify = useNotify()
  const [form, setForm] = useState<StratForm | null>(null)
  const st = status?.settings
  const fromSettings = (): StratForm | null => st ? {
    minEdge: String(+(st.strategy.minEdge * 100).toFixed(4)), minConfidence: String(+(st.strategy.minConfidence * 100).toFixed(4)),
    stake: String(st.strategy.stake), maxIntents: String(st.strategy.maxIntents), minLiquidity: String(st.strategy.minLiquidity),
    minPrice: String(+(st.strategy.minPrice * 100).toFixed(4)), maxPrice: String(+(st.strategy.maxPrice * 100).toFixed(4)),
    cap: String(st.maxDataPaymentLovelace / 1e6),
  } : null
  const f = form ?? fromSettings()
  if (!f) return <Card title="Strategy"><p className="text-[14px] text-dim">Waiting for the desk server.</p></Card>
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
      notify(reset ? 'Strategy reset to the repo defaults.' : 'Strategy saved. The next cycle uses it.')
      onSaved()
    } catch (e) { notify((e as Error).message, true) }
  }

  return (
    <Card title="Strategy" aside={<button onClick={() => save(true)} className="text-[13px] font-semibold text-violet hover:text-fg">Repo defaults</button>}>
      <Group>
        <Row label="Minimum edge" hint="Score minus price"><NumInput suffix="¢" value={f.minEdge} onChange={set('minEdge')} /></Row>
        <Row label="Minimum confidence"><NumInput suffix="%" value={f.minConfidence} onChange={set('minConfidence')} /></Row>
        <Row label="Stake per order"><NumInput prefix="$" value={f.stake} onChange={set('stake')} /></Row>
        <Row label="Orders per cycle"><NumInput value={f.maxIntents} onChange={set('maxIntents')} step="1" /></Row>
        <Row label="Minimum liquidity"><NumInput prefix="$" value={f.minLiquidity} onChange={set('minLiquidity')} /></Row>
        <Row label="Price band" hint="Lowest and highest YES price">
          <span className="flex items-center gap-1.5">
            <NumInput suffix="¢" value={f.minPrice} onChange={set('minPrice')} width="w-10" />
            <span className="text-faint">to</span>
            <NumInput suffix="¢" value={f.maxPrice} onChange={set('maxPrice')} width="w-10" />
          </span>
        </Row>
        <Row label="Data payment cap" hint="Most a cycle may pay for scores"><NumInput suffix="₳" value={f.cap} onChange={set('cap')} /></Row>
      </Group>
      <SaveBar show={form !== null} onSave={() => save()} onDiscard={() => setForm(null)} label="Save strategy" />
    </Card>
  )
}

function StressPanel({ onDone }: { onDone: () => void }) {
  const notify = useNotify()
  const [pnl, setPnl] = useState('-250')
  const shock = async () => {
    try {
      await api('/api/shock', { pnl: Number(pnl) })
      notify(`Booked a ${signed(Number(pnl))} shock.`, Number(pnl) < 0)
      onDone()
    } catch (e) { notify((e as Error).message, true) }
  }
  const reset = async () => {
    try {
      await api('/api/reset', {})
      notify('Book reset to $1,000. Policy and order history are kept.')
      onDone()
    } catch (e) { notify((e as Error).message, true) }
  }
  return (
    <Card title="Stress test">
      <Group>
        <Row label="P&L shock" hint="−250 trips both limits under the default policy."><NumInput prefix="$" value={pnl} onChange={setPnl} /></Row>
      </Group>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={shock} className={pillWhite}>Apply shock</button>
        <ArmButton className={`${pill} !text-loss`} armedLabel="Clear the book?" onConfirm={reset}>Reset book</ArmButton>
      </div>
    </Card>
  )
}

function BackendPanel({ status }: { status: Status | null }) {
  const notify = useNotify()
  const [showLog, setShowLog] = useState(false)
  const svc: [keyof Status['services'], string, number][] = [['control', 'Control API', 8787], ['cardano', 'Cardano payments', 8788], ['score', 'Score provider', 8789], ['feed', 'Market feed', 8790]]
  const call = async (what: 'start' | 'stop') => {
    try { notify(`Backend ${(await api<{ result: string }>(`/api/backend/${what}`, {})).result}.`) } catch (e) { notify((e as Error).message, true) }
  }
  const allUp = status ? Object.values(status.services).every(Boolean) : false
  return (
    <Card title="Backend" aside={<Server size={17} className="text-dim" />}>
      <Group>
        {svc.map(([k, name, port]) => (
          <Row key={k} label={name} hint={<span className="num">localhost:{port}</span>}>
            <span className={`flex items-center gap-1.5 text-[12px] font-bold ${status?.services[k] ? 'text-acid' : 'text-loss'}`}>
              {status?.services[k] ? 'Running' : 'Down'}
            </span>
          </Row>
        ))}
      </Group>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => call('start')} disabled={allUp} className={pillWhite}>Start</button>
        <ArmButton onConfirm={() => call('stop')} disabled={!status?.managed} armedLabel="Stop all four?">Stop</ArmButton>
        <button onClick={() => setShowLog(!showLog)} className="ml-auto text-[13px] font-semibold text-violet hover:text-fg">{showLog ? 'Hide' : 'Show'} output</button>
      </div>
      {showLog && (
        <pre className="mono mt-3 max-h-56 overflow-auto rounded-2xl bg-black/40 p-3 text-[10.5px] leading-relaxed text-dim scroll-thin">
          {status?.logs.join('\n') || 'No output yet.'}
        </pre>
      )}
    </Card>
  )
}

// ─── Time helpers ────────────────────────────────────────────────
function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
function dayOf(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}
function when(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${dayOf(iso) === 'Today' ? 'today' : dayOf(iso)} ${clockOf(iso)}`
}
