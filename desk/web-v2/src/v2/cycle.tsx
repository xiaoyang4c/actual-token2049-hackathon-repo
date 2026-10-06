import { motion } from 'motion/react'
import { Activity, AlertTriangle, Check, Coins, Database, OctagonX, Radar, Receipt, ShieldCheck, X } from 'lucide-react'
import type { AuditEvent } from '@/api'

type Stage = { key: string; label: string; value: string; state: 'idle' | 'ok' | 'bad' | 'skip' }

/** Turns one cycle's audit events into the five stages of the agent loop. */
export function stagesOf(events: AuditEvent[]): Stage[] {
  const find = (t: string) => events.find((e) => e.type === t)
  const count = (t: string) => events.filter((e) => e.type === t).length
  const halted = find('halted')
  const state = find('state')
  const elig = find('eligible_markets')
  const pay = find('cardano_payment')
  const refused = find('payment_refused')
  const approved = count('policy_approved')
  const blocked = count('policy_blocked')
  const filled = count('fill_filled')
  const rejected = count('fill_rejected')
  const error = find('cycle_error')
  const amount = find('x402_quote')?.detail.match(/^(\d+)/)?.[1]

  const s: Stage[] = [
    { key: 'state', label: 'Risk check', value: halted ? 'Halted' : state ? 'Clear' : '–', state: halted ? 'bad' : state ? 'ok' : 'idle' },
    { key: 'markets', label: 'Markets', value: elig ? elig.detail.split(' markets')[0] + ' eligible' : '–', state: elig ? (elig.detail.startsWith('0 ') ? 'bad' : 'ok') : 'idle' },
    { key: 'pay', label: 'Buy scores', value: pay ? `${amount ? Number(amount) / 1e6 : 1} ADA` : refused ? 'Refused' : '–', state: pay ? 'ok' : refused ? 'bad' : 'idle' },
    { key: 'policy', label: 'Policy gate', value: approved + blocked ? `${approved} ok · ${blocked} blocked` : find('signals') ? '0 proposed' : '–', state: approved ? 'ok' : blocked ? 'bad' : find('signals') ? 'skip' : 'idle' },
    { key: 'fill', label: 'Paper fills', value: filled + rejected ? `${filled} filled${rejected ? ` · ${rejected} rejected` : ''}` : '–', state: filled ? 'ok' : rejected ? 'bad' : 'idle' },
  ]
  if (error) {
    const i = s.findIndex((x) => x.state === 'idle')
    if (i >= 0) s[i] = { ...s[i], value: 'Error', state: 'bad' }
  }
  return s
}

const STAGE_ICON = [ShieldCheck, Radar, Coins, Activity, Receipt]

export function Stepper({ events, running }: { events: AuditEvent[]; running: boolean }) {
  const stages = stagesOf(running ? [] : events)
  const reached = stages.reduce((n, s, i) => (s.state !== 'idle' ? i + 1 : n), 0)
  const bad = stages.some((s) => s.state === 'bad')
  return (
    <div className="relative">
      <div className="absolute left-[10%] right-[10%] top-[23px] h-[6px] overflow-hidden rounded-full bg-white/[0.07] shadow-[inset_0_1px_2px_rgb(0_0_0/.35)]">
        <motion.div
          className={`h-full rounded-full ${bad ? 'bg-gradient-to-r from-violet to-loss' : 'bg-gradient-to-r from-violet to-acid'}`}
          initial={false}
          animate={{ width: running ? '0%' : `${Math.max(0, (reached - 1) / 4) * 100}%` }}
          transition={{ type: 'spring', stiffness: 70, damping: 18, delay: running ? 0 : 0.15 }}
        />
        {running && (
          <motion.div
            className="absolute top-0 h-full w-1/4 rounded-full bg-gradient-to-r from-transparent via-white to-transparent"
            animate={{ left: ['-25%', '100%'] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>
      <ol className="relative grid grid-cols-5 gap-1">
        {stages.map((s, i) => {
          const Icon = s.state === 'ok' ? Check : s.state === 'bad' ? X : STAGE_ICON[i]
          return (
            <li key={s.key} className="flex flex-col items-center text-center">
              <motion.span
                initial={false}
                animate={{ scale: s.state === 'idle' ? 1 : [0.7, 1.12, 1] }}
                transition={{ delay: running ? 0 : 0.1 + i * 0.12, duration: 0.5 }}
                className={`grid h-[52px] w-[52px] place-items-center rounded-full backdrop-blur-xl transition-colors duration-500 ${
                  s.state === 'ok' ? 'bg-acid text-ink shadow-[0_0_30px_-4px_rgb(62_230_168/.7),inset_0_1px_1px_rgb(255_255_255/.6)]'
                    : s.state === 'bad' ? 'bg-loss text-white shadow-[0_0_30px_-4px_rgb(255_92_122/.7),inset_0_1px_1px_rgb(255_255_255/.5)]'
                      : s.state === 'skip' ? 'bg-warn text-ink shadow-[inset_0_1px_1px_rgb(255_255_255/.6)]'
                        : 'bg-white/[0.08] text-dim shadow-[inset_0_1px_0_rgb(255_255_255/.25),inset_0_0_0_1px_rgb(255_255_255/.08)]'
                }`}
              >
                <Icon size={19} strokeWidth={2.4} />
              </motion.span>
              <span className="mt-2.5 text-[13px] font-semibold">{s.label}</span>
              <span className={`num mt-0.5 text-[12px] ${s.state === 'bad' ? 'text-loss' : 'text-dim'}`}>{running ? '…' : s.value}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const ICON: Record<string, [typeof Check, string]> = {
  state: [Database, 'bg-white/10 text-fg'],
  markets: [Radar, 'bg-white/10 text-fg'],
  eligible_markets: [Radar, 'bg-violet/25 text-violet'],
  x402_quote: [Receipt, 'bg-warn/20 text-warn'],
  cardano_payment: [Coins, 'bg-warn/20 text-warn'],
  signals: [Activity, 'bg-violet/25 text-violet'],
  policy_approved: [Check, 'bg-acid/20 text-acid'],
  fill_filled: [Check, 'bg-acid/20 text-acid'],
  policy_blocked: [X, 'bg-loss/20 text-loss'],
  fill_rejected: [X, 'bg-loss/20 text-loss'],
  halted: [OctagonX, 'bg-loss/20 text-loss'],
  payment_refused: [OctagonX, 'bg-loss/20 text-loss'],
  venue_error: [AlertTriangle, 'bg-loss/20 text-loss'],
  cycle_error: [AlertTriangle, 'bg-loss/20 text-loss'],
}

const pretty = (t: string) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function Events({ events, animate = true }: { events: AuditEvent[]; animate?: boolean }) {
  const rows = events.filter((e) => e.type !== 'cycle_start' && e.type !== 'cycle_end')
  return (
    <ul className="space-y-1">
      {rows.map((e, i) => {
        const [Icon, color] = ICON[e.type] ?? [Activity, 'bg-white/10 text-dim']
        return (
          <motion.li
            key={`${i}-${e.type}`}
            initial={animate ? { opacity: 0, y: 8, filter: 'blur(4px)' } : false}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ delay: animate ? i * 0.04 : 0, duration: 0.35 }}
            className="flex items-start gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-white/[0.04]"
          >
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${color}`}><Icon size={15} strokeWidth={2.4} /></span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[13px] font-semibold">{pretty(e.type)}</p>
              <p className="mt-0.5 text-[13px] leading-snug text-dim [overflow-wrap:anywhere]">{e.detail}</p>
            </div>
          </motion.li>
        )
      })}
    </ul>
  )
}
