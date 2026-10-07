import {useRef, type ReactNode} from 'react'
import {motion, useScroll, useSpring, useTransform, type Variants} from 'motion/react'
import {ArrowDownLeft, Lock, LockOpen} from 'lucide-react'
import DecryptedText from '@/components/reactbits/DecryptedText'
import {cn} from '@/lib/utils'
import {dateTime, pretty, usdm} from '@/lib/format'
import type {AuditRow, Escrow} from '@/lib/api'

/** Thin bar across the top that fills as the page scrolls. */
export function ScrollProgress() {
  const {scrollYProgress} = useScroll()
  const scaleX = useSpring(scrollYProgress, {stiffness: 140, damping: 28, mass: 0.3})
  return <motion.div aria-hidden style={{scaleX}} className="fixed inset-x-0 top-0 z-50 h-[3px] origin-left bg-gradient-to-r from-yellow via-[#8a9a3a] to-blue" />
}

/** Fades and lifts content into place the first time it scrolls into view. */
export function Reveal({children, delay = 0, className, y = 28}: {children: ReactNode; delay?: number; className?: string; y?: number}) {
  return (
    <motion.div
      className={className}
      initial={{opacity: 0, y, filter: 'blur(6px)'}}
      whileInView={{opacity: 1, y: 0, filter: 'blur(0px)'}}
      viewport={{once: true, amount: 0.15}}
      transition={{duration: 0.7, delay, ease: [0.22, 1, 0.36, 1]}}
    >
      {children}
    </motion.div>
  )
}

const list: Variants = {hidden: {}, show: {transition: {staggerChildren: 0.07}}}
const item: Variants = {hidden: {opacity: 0, y: 22, filter: 'blur(4px)'}, show: {opacity: 1, y: 0, filter: 'blur(0px)', transition: {duration: 0.55, ease: [0.22, 1, 0.36, 1]}}}

export function Stagger({children, className, as = 'div'}: {children: ReactNode; className?: string; as?: 'div' | 'ul'}) {
  const Comp = as === 'ul' ? motion.ul : motion.div
  return <Comp className={className} variants={list} initial="hidden" whileInView="show" viewport={{once: true, amount: 0.1}}>{children}</Comp>
}

export function StaggerItem({children, className, as = 'div'}: {children: ReactNode; className?: string; as?: 'div' | 'li'}) {
  const Comp = as === 'li' ? motion.li : motion.div
  return <Comp className={className} variants={item}>{children}</Comp>
}

/** Page-level enter animation. */
export function PageIn({children}: {children: ReactNode}) {
  return (
    <motion.div initial={{opacity: 0, y: 16, filter: 'blur(8px)'}} animate={{opacity: 1, y: 0, filter: 'blur(0px)'}} exit={{opacity: 0, y: -8}} transition={{duration: 0.5, ease: [0.22, 1, 0.36, 1]}}>
      {children}
    </motion.div>
  )
}

/** Hero that drifts up and fades as the page scrolls past it. */
export function ParallaxHero({children, className}: {children: ReactNode; className?: string}) {
  const ref = useRef<HTMLDivElement>(null)
  const {scrollYProgress} = useScroll({target: ref, offset: ['start start', 'end start']})
  const y = useTransform(scrollYProgress, [0, 1], [0, -90])
  const opacity = useTransform(scrollYProgress, [0, 0.85], [1, 0.15])
  return (
    <div ref={ref} className={className}>
      <motion.div style={{y, opacity}}>{children}</motion.div>
    </div>
  )
}

/* ---------- Funds flow: buyer → escrow → seller ---------- */

const LOCKED = new Set(['FundsLocked', 'ResultSubmitted', 'Disputed', 'RefundRequested'])

function Tokens({direction = 'right', tone = 'ink', vertical = false}: {direction?: 'right' | 'left'; tone?: 'ink' | 'yellow'; vertical?: boolean}) {
  const from = direction === 'right' ? '-6%' : '100%'
  const to = direction === 'right' ? '100%' : '-6%'
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={cn('absolute size-[7px] rounded-[1.5px]', tone === 'ink' ? 'bg-ink' : 'bg-yellow shadow-[0_0_0_1px_rgb(11_14_15/0.25)]', vertical ? 'left-1/2 -translate-x-1/2' : 'top-1/2 -translate-y-1/2')}
          initial={vertical ? {top: from, opacity: 0} : {left: from, opacity: 0}}
          animate={vertical ? {top: [from, to], opacity: [0, 1, 1, 0]} : {left: [from, to], opacity: [0, 1, 1, 0]}}
          transition={{duration: 2.4, repeat: Infinity, ease: 'linear', delay: i * 0.8, times: [0, 0.15, 0.85, 1]}}
        />
      ))}
    </>
  )
}

function Lane({active, refund, label}: {active: boolean; refund?: boolean; label: string}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 py-2 md:py-0">
      {/* Horizontal on desktop, vertical on phones. */}
      <div className="relative hidden h-6 w-full md:block">
        <div className={cn('absolute inset-x-0 top-1/2 h-px -translate-y-1/2', active || refund ? 'bg-ink/30' : 'border-t border-dashed border-ink/25 bg-transparent')} />
        {active ? <Tokens /> : null}
        {refund ? <Tokens direction="left" tone="yellow" /> : null}
      </div>
      <div className="relative h-12 w-6 md:hidden">
        <div className={cn('absolute inset-y-0 left-1/2 w-px -translate-x-1/2', active || refund ? 'bg-ink/30' : 'border-l border-dashed border-ink/25')} />
        {active ? <Tokens vertical /> : null}
        {refund ? <Tokens vertical direction="left" tone="yellow" /> : null}
      </div>
      <span className="eyebrow text-center">{label}</span>
    </div>
  )
}

function Node({title, name, children, dark}: {title: string; name: string; children?: ReactNode; dark?: boolean}) {
  return (
    <div className={cn('w-full rounded-[14px] p-4 md:w-[13rem] md:shrink-0', dark ? 'surface-ink' : 'surface')}>
      <p className={cn('eyebrow', dark && 'text-white/50')}>{title}</p>
      <p className="mt-1.5 truncate text-[14px] font-semibold">{name}</p>
      {children}
    </div>
  )
}

export function FundsFlow({escrows, buyer, seller}: {escrows: Escrow[]; buyer: string; seller: string}) {
  const funded = escrows.some((e) => e.onChainState)
  const locked = escrows.filter((e) => e.onChainState && LOCKED.has(e.onChainState))
  const released = escrows.filter((e) => e.onChainState === 'Withdrawn')
  const refunded = escrows.filter((e) => e.onChainState === 'RefundWithdrawn')
  const total = escrows.reduce((sum, e) => sum + BigInt(e.amountAtomic), 0n)
  return (
    <div className="flex flex-col items-stretch md:flex-row md:items-center">
      <Node title="Buyer" name={buyer}>
        {refunded.length ? <p className="mt-2 flex items-center gap-1 text-[12px] text-ink-2"><ArrowDownLeft className="size-3.5" />Refunded <span className="num font-medium">{usdm(refunded.reduce((s, e) => s + BigInt(e.amountAtomic), 0n))}</span></p> : null}
      </Node>
      <Lane active={locked.length > 0} refund={refunded.length > 0} label={refunded.length ? 'Refund' : funded ? 'Funded' : 'Not funded'} />
      <Node title="Masumi escrow" name={`${usdm(total)} test USDM`} dark>
        <div className="mt-3 space-y-1.5">
          {escrows.map((e) => {
            const isLocked = e.onChainState ? LOCKED.has(e.onChainState) : false
            return (
              <div key={e.role} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="flex items-center gap-1.5 capitalize text-white/80">{isLocked ? <Lock className="size-3 text-yellow" /> : <LockOpen className="size-3 text-white/40" />}{e.role}</span>
                <span className="mono text-[11px] text-white/60">{e.onChainState ?? 'empty'}</span>
              </div>
            )
          })}
        </div>
      </Node>
      <Lane active={released.length > 0} label={released.length ? 'Released' : 'Waiting'} />
      <Node title="Seller" name={seller}>
        {released.length ? <p className="mt-2 text-[12px] text-ink-2">Paid <span className="num font-medium">{usdm(released.reduce((s, e) => s + BigInt(e.amountAtomic), 0n))}</span></p> : null}
      </Node>
    </div>
  )
}

/* ---------- Audit log as a chain of blocks ---------- */

export function BlockChain({rows, intact}: {rows: AuditRow[]; intact: boolean}) {
  const ref = useRef<HTMLOListElement>(null)
  const {scrollYProgress} = useScroll({target: ref, offset: ['start 85%', 'end 55%']})
  const scaleY = useSpring(scrollYProgress, {stiffness: 120, damping: 26})
  return (
    <ol ref={ref} className="relative space-y-3 pl-9">
      <div className="absolute bottom-3 left-[11px] top-3 w-[2px] bg-ink/10" aria-hidden />
      <motion.div className={cn('absolute bottom-3 left-[11px] top-3 w-[2px] origin-top', intact ? 'bg-gradient-to-b from-ink to-blue' : 'bg-down')} style={{scaleY}} aria-hidden />
      {rows.map((row, i) => (
        <motion.li
          key={row.seq}
          className="relative"
          initial={{opacity: 0, x: -14}}
          whileInView={{opacity: 1, x: 0}}
          viewport={{once: true, amount: 0.4}}
          transition={{duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: Math.min(i, 3) * 0.04}}
        >
          <span className="absolute -left-9 top-3.5 grid size-6 place-items-center rounded-[6px] border border-ink/15 bg-white text-[9px] font-semibold text-ink shadow-sm" aria-hidden>
            <span className="mono">{String(i + 1).padStart(2, '0')}</span>
          </span>
          <div className="surface rounded-[12px] px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-[13.5px] font-semibold">{pretty(row.event)}</p>
              <span className="mono text-[11px] text-ink-3">block {row.seq} · {dateTime(row.at)}</span>
            </div>
            <p className="mt-0.5 text-[12px] text-ink-3">{row.actor}{row.fromState || row.toState ? ` · ${row.fromState ?? '—'} → ${row.toState ?? '—'}` : ''}</p>
            <div className="mt-2 grid gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
              <p className="truncate text-ink-3"><span className="eyebrow mr-1.5 text-[9.5px]">prev</span><span className="mono">{row.prevHash.slice(0, 18)}…</span></p>
              <p className="truncate"><span className="eyebrow mr-1.5 text-[9.5px]">hash</span><DecryptedText text={`${row.hash.slice(0, 18)}…`} animateOn="view" sequential speed={22} characters="0123456789abcdef" className="mono text-ink" encryptedClassName="mono text-ink-3" /></p>
            </div>
          </div>
        </motion.li>
      ))}
    </ol>
  )
}
