import {createContext, useContext, useEffect, useState, type ReactNode} from 'react'
import {Check, Copy} from 'lucide-react'
import DecryptedText from '@/components/reactbits/DecryptedText'
import {Badge} from '@/components/ui/badge'
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip'
import {cn} from '@/lib/utils'
import {STAGES, STATE_LABEL, relative, stageIndex, stateTone, type Tone} from '@/lib/format'

export function TallyMark({className = 'h-6 w-7'}: {className?: string}) {
  return <img src="/brand/tally-mark.svg" alt="" className={className} />
}

export function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <TallyMark />
      <span className="display text-[18px]">Tally</span>
    </span>
  )
}

const TONE: Record<Tone, string> = {
  ink: 'bg-black/[0.06] text-ink',
  up: 'bg-up-wash text-up',
  warn: 'bg-warn-wash text-warn',
  blue: 'bg-blue-wash text-blue',
  down: 'bg-down-wash text-down',
  quiet: 'bg-black/[0.04] text-ink-3',
}

export function Tag({tone = 'ink', children, className}: {tone?: Tone; children: ReactNode; className?: string}) {
  return <Badge className={cn('h-6 rounded-[5px] px-2 text-[12px] font-medium', TONE[tone], className)}>{children}</Badge>
}

export function StateTag({state}: {state: string}) {
  return <Tag tone={stateTone(state)}>{STATE_LABEL[state] ?? state}</Tag>
}

export function SimTag() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="eyebrow inline-flex h-6 items-center rounded-[5px] border border-dashed border-black/20 px-1.5 text-[10px] text-ink-3" />}>
        Simulated
      </TooltipTrigger>
      <TooltipContent>Paper contract. No chain transaction was sent.</TooltipContent>
    </Tooltip>
  )
}

/** Six stages; the current one is ink, a dispute marks the inspection stage in yellow. */
export function StageTrack({state, terminal, compact = false}: {state: string; terminal: boolean; compact?: boolean}) {
  const {index, disputed} = stageIndex(state, terminal)
  return (
    <div className="w-full">
      <div className="flex gap-1">
        {STAGES.map((stage, i) => (
          <div key={stage} className="min-w-0 flex-1">
            <div
              className={cn(
                'h-[5px] rounded-[2px] transition-colors',
                i < index ? 'bg-ink' : i === index ? (disputed && i >= 3 ? 'bg-yellow' : 'bg-ink') : 'bg-black/[0.08]',
                i === 3 && disputed && index > 3 && 'bg-yellow',
              )}
            />
            {!compact && (
              <p className={cn('mt-2 truncate text-[11.5px]', i === index ? 'font-semibold text-ink' : 'text-ink-3')}>
                {i === 3 && disputed ? 'Dispute' : stage}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Relative time that refreshes every 30 s. */
export function Countdown({ms, className}: {ms: number; className?: string}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const soon = ms - now < 86_400_000 && ms > now
  return <span className={cn('num', soon && 'text-down', className)}>{relative(ms, now)}</span>
}

export function Amount({display, className}: {display: string; className?: string}) {
  const [value, ...unit] = display.split(' ')
  return (
    <span className={cn('whitespace-nowrap', className)}>
      <span className="num">{value}</span>
      <span className="ml-1 text-[0.72em] font-normal text-ink-3">{unit.join(' ') || 'test USDM'}</span>
    </span>
  )
}

/** A hash that decrypts into view on hover, with a copy button. */
export function Hash({value, n = 8, className}: {value: string; n?: number; className?: string}) {
  const [copied, setCopied] = useState(false)
  const short = value.length > 2 * n + 1 ? `${value.slice(0, n)}…${value.slice(-n)}` : value
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <DecryptedText text={short} animateOn="hover" speed={28} maxIterations={8} sequential revealDirection="start" characters="0123456789abcdef" className="mono text-[12px] text-ink-2" encryptedClassName="mono text-[12px] text-ink-3" />
      <button
        type="button"
        aria-label="Copy"
        onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
        className="rounded-[4px] p-1 text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
}

export function PageHeader({eyebrow, title, description, actions}: {eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="eyebrow mb-4 flex items-center gap-2">
            <span className="h-px w-6 bg-ink/40" aria-hidden />{eyebrow}
          </div>
        ) : null}
        <h1 className="display text-gradient text-[34px] sm:text-[52px]">{title}</h1>
        {description ? <p className="mt-4 max-w-[60ch] text-[15px] leading-relaxed text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  )
}

export function Section({title, aside, children, className, bodyClassName}: {title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string}) {
  return (
    <section className={cn('surface rounded-[14px]', className)}>
      {title ? (
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <h2 className="font-[family-name:var(--font-display)] text-[13.5px] font-medium tracking-[-0.01em]">{title}</h2>
          {aside ? <div className="text-[12.5px] text-ink-3">{aside}</div> : null}
        </div>
      ) : null}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  )
}

export function KV({rows, className}: {rows: Array<[ReactNode, ReactNode]>; className?: string}) {
  return (
    <dl className={cn('grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13.5px]', className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Stat({label, children, hint}: {label: ReactNode; children: ReactNode; hint?: ReactNode}) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <div className="display mt-3 text-[30px] leading-none">{children}</div>
      {hint ? <p className="mt-2 text-[12.5px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

export function Empty({title, children}: {title: string; children?: ReactNode}) {
  return (
    <div className="rounded-[12px] border border-dashed border-black/15 px-6 py-10 text-center">
      <p className="text-[14.5px] font-medium">{title}</p>
      {children ? <p className="mt-1.5 text-[13px] text-ink-3">{children}</p> : null}
    </div>
  )
}

export function ErrorNote({children}: {children: ReactNode}) {
  return <div className="rounded-[10px] bg-down-wash px-4 py-3 text-[13.5px] text-down">{children}</div>
}

/* Viewing-as lens: everything filters to one party, or all parties. */
const LensContext = createContext<{lens: string; setLens: (id: string) => void}>({lens: 'all', setLens: () => {}})

export function LensProvider({children}: {children: ReactNode}) {
  const [lens, setLensState] = useState(() => {
    try { return localStorage.getItem('tally-studio-lens') ?? 'all' } catch { return 'all' }
  })
  const setLens = (id: string) => {
    setLensState(id)
    try { localStorage.setItem('tally-studio-lens', id) } catch { /* storage unavailable */ }
  }
  return <LensContext.Provider value={{lens, setLens}}>{children}</LensContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useLens = () => useContext(LensContext)
