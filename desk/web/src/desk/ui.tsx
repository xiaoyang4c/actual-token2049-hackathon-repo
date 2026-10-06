import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import SpotlightCard from '@/components/SpotlightCard'
import CountUp from '@/components/CountUp'

// ─── Panel: React Bits SpotlightCard with a glass finish ───────────
export function Panel({ title, aside, children, className = '', tint = 'rgba(196, 242, 91, 0.08)' }: {
  title?: string; aside?: ReactNode; children: ReactNode; className?: string
  tint?: `rgba(${number}, ${number}, ${number}, ${number})`
}) {
  return (
    <SpotlightCard className={`glass !rounded-[22px] !p-5 sm:!p-6 ${className}`} spotlightColor={tint}>
      {(title || aside) && (
        <div className="relative mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-medium tracking-tight text-fg">{title}</h2>}
          {aside}
        </div>
      )}
      <div className="relative">{children}</div>
    </SpotlightCard>
  )
}

// ─── Animated money, built on React Bits CountUp ──────────────────
export function Money({ value, className = '', sign = false }: { value: number; className?: string; sign?: boolean }) {
  const prev = useRef(value)
  const from = prev.current
  useEffect(() => { prev.current = value }, [value])
  const neg = value < -0.004
  return (
    <span className={className}>
      {neg ? '−' : sign && value > 0.004 ? '+' : ''}$
      <CountUp from={Math.abs(from)} to={Math.abs(value)} decimals={2} separator="," duration={0.9} />
    </span>
  )
}

// ─── Toasts ───────────────────────────────────────────────────────
type Toast = { id: number; text: string; bad: boolean }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, bad }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3800)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex w-[min(520px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className={`glass !bg-[#101216]/95 rounded-2xl px-4 py-3 text-sm ${t.bad ? 'text-loss' : 'text-fg'}`}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}

// ─── Two-step button (no browser confirm dialogs) ────────────────
export function ArmButton({ children, armedLabel, onConfirm, className = '', disabled }: {
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
      disabled={disabled}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={`${className} ${armed ? '!border-loss !bg-loss/15 !text-loss' : ''}`}
    >
      {armed ? armedLabel : children}
    </button>
  )
}

export const btn =
  'rounded-full border border-white/12 bg-white/[0.04] px-3.5 py-1.5 text-[13px] text-fg transition-colors hover:border-white/30 hover:bg-white/[0.09] disabled:opacity-40 disabled:hover:bg-white/[0.04]'

// ─── Number field ─────────────────────────────────────────────────
export function Field({ label, suffix, value, onChange, step = 'any' }: {
  label: string; suffix?: string; value: string; onChange: (v: string) => void; step?: string
}) {
  return (
    <label className="group flex items-center justify-between gap-3 border-b border-white/[0.06] py-2 text-[13px] text-dim">
      <span className="transition-colors group-focus-within:text-fg">{label}</span>
      <span className="flex items-baseline gap-1">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="num w-20 bg-transparent text-right text-[14px] text-fg outline-none"
        />
        {suffix && <span className="num w-5 text-[11px] text-faint">{suffix}</span>}
      </span>
    </label>
  )
}

// ─── Chips ────────────────────────────────────────────────────────
export function Chip({ on, onClick, children, kind = 'on' }: { on: boolean; onClick: () => void; children: ReactNode; kind?: 'on' | 'deny' }) {
  const active = kind === 'deny' ? 'border-loss/60 bg-loss/15 text-loss' : 'border-acid/60 bg-acid/12 text-acid'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`num rounded-full border px-2.5 py-1 text-[11px] transition-colors ${on ? active : 'border-white/10 text-dim hover:border-white/25 hover:text-fg'}`}
    >
      {children}
    </button>
  )
}
