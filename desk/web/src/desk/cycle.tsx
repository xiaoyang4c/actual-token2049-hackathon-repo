import { motion } from 'motion/react'
import { Activity, AlertTriangle, Check, Coins, Database, OctagonX, Radar, Receipt, X } from 'lucide-react'
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
    { key: 'state', label: 'Risk check', value: halted ? 'halted' : state ? 'clear' : '–', state: halted ? 'bad' : state ? 'ok' : 'idle' },
    { key: 'markets', label: 'Markets', value: elig ? elig.detail.split(' markets')[0] : '–', state: elig ? (elig.detail.startsWith('0 ') ? 'bad' : 'ok') : 'idle' },
    { key: 'pay', label: 'Buy scores', value: pay ? `${amount ? Number(amount) / 1e6 : 1} ADA` : refused ? 'refused' : '–', state: pay ? 'ok' : refused ? 'bad' : 'idle' },
    { key: 'policy', label: 'Policy gate', value: approved + blocked ? `${approved} ok · ${blocked} blocked` : find('signals') ? '0 proposed' : '–', state: approved ? 'ok' : blocked ? 'bad' : find('signals') ? 'skip' : 'idle' },
    { key: 'fill', label: 'Paper fills', value: filled + rejected ? `${filled} filled${rejected ? ` · ${rejected} rejected` : ''}` : '–', state: filled ? 'ok' : rejected ? 'bad' : 'idle' },
  ]
  if (error) {
    const i = s.findIndex((x) => x.state === 'idle')
    if (i >= 0) s[i] = { ...s[i], value: 'error', state: 'bad' }
  }
  return s
}

export function Pipeline({ events, running }: { events: AuditEvent[]; running: boolean }) {
  const stages = stagesOf(running ? [] : events)
  return (
    <div className="relative">
      <div className="absolute left-[10%] right-[10%] top-[15px] h-px bg-white/10" />
      {running && (
        <motion.div
          className="absolute top-[14px] h-[3px] w-24 rounded-full bg-gradient-to-r from-transparent via-acid to-transparent"
          initial={{ left: '5%' }}
          animate={{ left: ['5%', '80%'] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <ol className="relative grid grid-cols-5 gap-1">
        {stages.map((s, i) => (
          <li key={s.key} className="flex flex-col items-center text-center">
            <motion.span
              initial={false}
              animate={{ scale: s.state === 'idle' ? 1 : [0.6, 1.15, 1] }}
              transition={{ delay: running ? 0 : i * 0.12, duration: 0.45 }}
              className={`grid h-[30px] w-[30px] place-items-center rounded-full border text-[11px] ${
                s.state === 'ok' ? 'border-acid/70 bg-acid/15 text-acid shadow-[0_0_24px_-4px] shadow-acid/60'
                  : s.state === 'bad' ? 'border-loss/70 bg-loss/15 text-loss shadow-[0_0_24px_-4px] shadow-loss/60'
                    : s.state === 'skip' ? 'border-warn/60 bg-warn/10 text-warn'
                      : 'border-white/15 bg-ink text-faint'
              }`}
            >
              {s.state === 'ok' ? <Check size={14} /> : s.state === 'bad' ? <X size={14} /> : i + 1}
            </motion.span>
            <span className="mt-2 text-[12px] text-fg">{s.label}</span>
            <span className={`num mt-0.5 text-[11px] ${s.state === 'bad' ? 'text-loss' : s.state === 'ok' ? 'text-dim' : 'text-faint'}`}>{running ? '…' : s.value}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const ICON: Record<string, [typeof Check, string]> = {
  state: [Database, 'text-dim'],
  markets: [Radar, 'text-dim'],
  eligible_markets: [Radar, 'text-fg'],
  x402_quote: [Receipt, 'text-warn'],
  cardano_payment: [Coins, 'text-warn'],
  signals: [Activity, 'text-fg'],
  policy_approved: [Check, 'text-acid'],
  fill_filled: [Check, 'text-acid'],
  policy_blocked: [X, 'text-loss'],
  fill_rejected: [X, 'text-loss'],
  halted: [OctagonX, 'text-loss'],
  payment_refused: [OctagonX, 'text-loss'],
  venue_error: [AlertTriangle, 'text-loss'],
  cycle_error: [AlertTriangle, 'text-loss'],
}

export function Dispatch({ events, animate = true }: { events: AuditEvent[]; animate?: boolean }) {
  const rows = events.filter((e) => e.type !== 'cycle_start' && e.type !== 'cycle_end')
  return (
    <ul className="divide-y divide-white/[0.05]">
      {rows.map((e, i) => {
        const [Icon, color] = ICON[e.type] ?? [Activity, 'text-dim']
        const bad = color === 'text-loss'
        return (
          <motion.li
            key={`${i}-${e.type}`}
            initial={animate ? { opacity: 0, x: -10, filter: 'blur(4px)' } : false}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            transition={{ delay: animate ? i * 0.045 : 0, duration: 0.35 }}
            className="grid grid-cols-[20px_120px_minmax(0,1fr)] items-start gap-2 py-2 text-[13px] max-sm:grid-cols-[20px_minmax(0,1fr)]"
          >
            <Icon size={14} className={`mt-[3px] ${color}`} />
            <span className="num pt-[1px] text-[11px] text-faint max-sm:hidden">{e.type.replace(/_/g, ' ')}</span>
            <span className={`[overflow-wrap:anywhere] ${bad ? 'text-loss/90' : 'text-fg/85'}`}>{e.detail}</span>
          </motion.li>
        )
      })}
    </ul>
  )
}
