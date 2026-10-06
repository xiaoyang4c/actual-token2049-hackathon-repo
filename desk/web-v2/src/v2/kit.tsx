import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import NumberFlow, { NumberFlowGroup } from '@number-flow/react'
import GlassSurface from '@/components/GlassSurface'

// ─── Liquid glass card ────────────────────────────────────────────
// CSS glass with a specular rim and a highlight that follows the cursor.
export function Glass({ children, className = '', style, as: Tag = 'div' }: {
  children: ReactNode; className?: string; style?: CSSProperties; as?: 'div' | 'section'
}) {
  const track = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
  }
  return (
    <Tag onMouseMove={track} className={`lg rounded-[30px] ${className}`} style={style}>
      {children}
    </Tag>
  )
}

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Glass as="section" className={`p-5 sm:p-6 ${className}`}>
      {(title || aside) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>}
          {aside}
        </header>
      )}
      <div>{children}</div>
    </Glass>
  )
}

// ─── Refracting glass (React Bits GlassSurface) ───────────────────
export function Refract({ children, radius = 999, className = '', contentClassName, width = 'auto', height = 'auto', tint = 0.18, frost = 0.6 }: {
  children: ReactNode; radius?: number; className?: string; contentClassName?: string; width?: number | string; height?: number | string; tint?: number; frost?: number
}) {
  return (
    <GlassSurface
      width={width}
      height={height}
      borderRadius={radius}
      backgroundOpacity={tint}
      saturation={1.6}
      brightness={60}
      opacity={0.9}
      blur={10}
      displace={frost}
      distortionScale={-150}
      redOffset={0}
      greenOffset={8}
      blueOffset={16}
      className={className}
      contentClassName={contentClassName ?? 'flex h-full w-full items-center'}
    >
      {children}
    </GlassSurface>
  )
}

// ─── Money with rolling digits and smaller cents ──────────────────
export function Balance({ value, className = '', centsClassName = 'text-[0.5em]' }: { value: number; className?: string; centsClassName?: string }) {
  const total = Math.round(Math.abs(value) * 100)
  const neg = value < -0.004
  return (
    <NumberFlowGroup>
      <span className={`inline-flex items-baseline ${className}`}>
        {neg && <span>−</span>}
        <NumberFlow value={Math.floor(total / 100)} prefix="$" format={{ useGrouping: true }} />
        <NumberFlow value={total % 100} prefix="." format={{ minimumIntegerDigits: 2 }} className={centsClassName} />
      </span>
    </NumberFlowGroup>
  )
}

export function Flow({ value, signed = false, decimals = 2, prefix = '$', suffix, className = '' }: {
  value: number; signed?: boolean; decimals?: number; prefix?: string; suffix?: string; className?: string
}) {
  const neg = value < -0.004
  const sign = neg ? '−' : signed && value > 0.004 ? '+' : ''
  return (
    <NumberFlow
      value={Math.abs(value)}
      prefix={`${sign}${prefix}`}
      suffix={suffix}
      format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
      className={className}
    />
  )
}

// ─── Ring gauge ───────────────────────────────────────────────────
export function Ring({ frac, size = 92, stroke = 9, color, children }: { frac: number; size?: number; stroke?: number; color: string; children?: ReactNode }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const f = Math.max(0, Math.min(1, frac))
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 overflow-visible">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / .09)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.max(f, f > 0 ? 0.02 : 0)) }}
          transition={{ type: 'spring', stiffness: 60, damping: 18 }}
          style={{ filter: `drop-shadow(0 0 8px ${color})` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  )
}

// ─── Toggle (iOS style) ───────────────────────────────────────────
export function Toggle({ on, onClick, danger }: { on: boolean; onClick?: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-[30px] w-[50px] shrink-0 items-center rounded-full transition-colors duration-300 ${
        on ? (danger ? 'bg-loss' : 'bg-acid') : 'bg-white/[0.14]'
      } shadow-[inset_0_1px_1px_rgb(0_0_0/.25)]`}
    >
      <motion.span
        initial={false}
        animate={{ x: on ? 22 : 2 }}
        transition={{ type: 'spring', stiffness: 520, damping: 32 }}
        className="absolute left-0 h-[26px] w-[26px] rounded-full bg-white shadow-[0_3px_8px_rgb(0_0_0/.3),0_0_0_.5px_rgb(0_0_0/.04)]"
      />
    </button>
  )
}

// ─── Segmented control ────────────────────────────────────────────
export function Segmented<T extends string>({ value, options, onChange, id, size = 'md' }: {
  value: T; options: [T, ReactNode][]; onChange: (v: T) => void; id: string; size?: 'sm' | 'md'
}) {
  return (
    <div className="lg-soft flex rounded-full p-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`relative rounded-full font-medium transition-colors ${size === 'sm' ? 'px-3 py-1 text-[12px]' : 'px-4 py-1.5 text-[13px]'} ${value === v ? 'text-ink' : 'text-dim hover:text-fg'}`}
        >
          {value === v && (
            <motion.span
              layoutId={`seg-${id}`}
              className="absolute inset-0 rounded-full bg-white shadow-[0_2px_10px_rgb(0_0_0/.25)]"
              transition={{ type: 'spring', stiffness: 500, damping: 36 }}
            />
          )}
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Buttons ──────────────────────────────────────────────────────
export const pill =
  'lg-soft inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-fg transition-colors disabled:pointer-events-none disabled:opacity-40'
export const pillWhite =
  'inline-flex items-center justify-center gap-1.5 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-ink transition-transform active:scale-[.97] disabled:pointer-events-none disabled:opacity-40'

export function ArmButton({ children, armedLabel, onConfirm, className = pill, disabled }: {
  children: ReactNode; armedLabel: string; onConfirm: () => void | Promise<void>; className?: string; disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3500)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={`${className} ${armed ? '!bg-loss !text-white' : ''}`}
    >
      {armed ? armedLabel : children}
    </button>
  )
}

// ─── Settings-style rows ──────────────────────────────────────────
export function Group({ children }: { children: ReactNode }) {
  return <div className="lg-soft divide-y divide-white/[0.06] overflow-hidden rounded-[20px]">{children}</div>
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[14px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] text-dim">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function NumInput({ value, onChange, suffix, prefix, step = 'any', width = 'w-20' }: {
  value: string; onChange: (v: string) => void; suffix?: string; prefix?: string; step?: string; width?: string
}) {
  return (
    <label className="flex shrink-0 items-baseline gap-1 rounded-xl bg-black/25 px-3 py-1.5 shadow-[inset_0_1px_2px_rgb(0_0_0/.3)] focus-within:ring-1 focus-within:ring-violet/70">
      {prefix && <span className="text-[13px] text-faint">{prefix}</span>}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`num ${width} bg-transparent text-right text-[14px] font-semibold text-fg outline-none`}
      />
      {suffix && <span className="text-[12px] text-faint">{suffix}</span>}
    </label>
  )
}

export function Chip({ on, onClick, children, kind = 'on' }: { on: boolean; onClick: () => void; children: ReactNode; kind?: 'on' | 'deny' }) {
  const active = kind === 'deny' ? 'bg-loss/90 text-white' : 'bg-white text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${on ? active : 'lg-soft text-dim hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

// ─── Venue avatar ─────────────────────────────────────────────────
export function VenueMark({ venue, size = 40 }: { venue: string; size?: number }) {
  const poly = venue === 'polymarket'
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full text-[13px] font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_6px_16px_-6px_rgb(0_0_0/.6)]"
      style={{ width: size, height: size, background: poly ? 'linear-gradient(145deg,#4f6bff,#2333c9)' : 'linear-gradient(145deg,#2fd39a,#0b8f63)' }}
    >
      {poly ? 'P' : 'K'}
    </span>
  )
}

// ─── Island messages (replaces toasts) ────────────────────────────
export type Note = { id: number; text: string; bad: boolean }
const NoteCtx = createContext<{ note: Note | null; notify: (text: string, bad?: boolean) => void }>({ note: null, notify: () => {} })
export const useNotify = () => useContext(NoteCtx).notify
export const useNote = () => useContext(NoteCtx).note

export function NoteHost({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<Note | null>(null)
  const notify = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random()
    setNote({ id, text, bad })
    setTimeout(() => setNote((n) => (n?.id === id ? null : n)), bad ? 6500 : 4200)
  }, [])
  return <NoteCtx.Provider value={{ note, notify }}>{children}</NoteCtx.Provider>
}
