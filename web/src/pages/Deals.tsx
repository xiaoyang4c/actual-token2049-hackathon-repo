import {useMemo, useState} from 'react'
import {Link} from 'react-router-dom'
import {ArrowUpRight} from 'lucide-react'
import CountUp from '@/components/reactbits/CountUp'
import SpotlightCard from '@/components/reactbits/SpotlightCard'
import {Amount, Countdown, Empty, ErrorNote, SimTag, StageTrack, StateTag, Tag, useLens} from '@/components/kit'
import {ParallaxHero, Reveal, Stagger, StaggerItem} from '@/components/motion'
import {Skeleton} from '@/components/ui/skeleton'
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {api, type ContractSummary, type MilestoneSummary} from '@/lib/api'
import {dateTime, usdm} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const LOCKED = new Set(['funded', 'delivered', 'in_inspection', 'disputed', 'tier_1_negotiation', 'tier_2_evidence_rule', 'tier_3_mediation', 'accepted_pending_release', 'resolved', 'return_pending', 'redo_pending', 'redo_inspection'])

type Row = {contract: ContractSummary; milestone: MilestoneSummary}
type Filter = 'all' | 'action' | 'disputes' | 'closed'

const acts = (r: Row) => !!r.milestone.next && r.milestone.next.actor !== 'none'

function InkStat({label, value, suffix}: {label: string; value: number; suffix?: string}) {
  return (
    <div className="min-w-0 px-5 py-5">
      <p className="eyebrow text-white/45">{label}</p>
      {/* The final value sits invisibly underneath, so the box keeps its size while the count runs. */}
      <p className="display relative mt-3 text-[34px] leading-none text-white [font-variant-numeric:tabular-nums]">
        <span className="invisible" aria-hidden>{value.toLocaleString('en-US')}</span>
        <span className="absolute inset-0 whitespace-nowrap"><CountUp to={value} duration={1} separator="," /></span>
      </p>
      {suffix ? <p className="mt-2 text-[12px] text-white/50">{suffix}</p> : null}
    </div>
  )
}

export function DealsPage() {
  const {lens} = useLens()
  const contracts = useAsync(() => api.contracts({partyId: lens === 'all' ? undefined : lens}), `contracts-${lens}`)
  const [filter, setFilter] = useState<Filter>('all')

  const rows = useMemo<Row[]>(() => (contracts.data ?? []).flatMap((contract) => contract.milestones.map((milestone) => ({contract, milestone}))), [contracts.data])
  const roleOf = (c: ContractSummary) => (lens === c.buyer.id ? 'buyer' : lens === c.seller.id ? 'seller' : null)
  const yourMove = (r: Row) => acts(r) && lens !== 'all' && (r.milestone.next!.actor === roleOf(r.contract) || r.milestone.next!.actor === 'both')

  const open = rows.filter((r) => !r.milestone.terminal)
  const disputes = rows.filter((r) => r.milestone.inDispute)
  const closed = rows.filter((r) => r.milestone.terminal)
  const waiting = lens === 'all' ? open.filter(acts) : open.filter(yourMove)
  const locked = rows.filter((r) => LOCKED.has(r.milestone.state)).reduce((sum, r) => sum + BigInt(r.milestone.amount.atomic), 0n)

  const shown = filter === 'action' ? waiting : filter === 'disputes' ? disputes : filter === 'closed' ? closed : rows
  const lensName = lens === 'all' ? null : rows.find((r) => r.contract.buyer.id === lens)?.contract.buyer.displayName ?? rows.find((r) => r.contract.seller.id === lens)?.contract.seller.displayName

  return (
    <div className="space-y-12">
      <section className="relative pb-6 pt-2 lg:pt-4">
        <ParallaxHero className="relative">
          <div className="eyebrow mb-5 flex items-center gap-2"><span className="h-px w-6 bg-ink/40" aria-hidden />{lensName ? `Deals · ${lensName}` : 'Deals · all parties'}</div>
          <h1 className="display text-gradient max-w-[16ch] text-[40px] sm:text-[64px] lg:text-[76px]">Funds move when the evidence does.</h1>
          <p className="mt-6 max-w-[56ch] text-[15.5px] leading-relaxed text-ink-2">
            Every milestone has one party who has to act next, and a deadline. Money waits in a Masumi escrow on Cardano until the evidence named in the signed terms arrives.
          </p>
        </ParallaxHero>
      </section>

      <Reveal>
        <section className="surface-ink grid grid-cols-2 divide-white/10 overflow-hidden rounded-[18px] sm:grid-cols-3 sm:divide-x lg:grid-cols-5">
          <InkStat label="Open milestones" value={open.length} />
          <InkStat label={lens === 'all' ? 'Waiting on a party' : 'Your move'} value={waiting.length} />
          <InkStat label="In dispute" value={disputes.length} />
          <InkStat label="Closed" value={closed.length} />
          <div className="col-span-2 sm:col-span-1"><InkStat label="Locked in escrow" value={Number(locked / 1_000_000n)} suffix="test USDM" /></div>
        </section>
      </Reveal>

      <div className="space-y-5">
        <Reveal>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList className="h-auto flex-wrap gap-0.5 group-data-horizontal/tabs:h-auto rounded-[11px] border border-white/70 bg-white/45 p-1 backdrop-blur-md">
              {([['all', 'All', rows.length], ['action', lens === 'all' ? 'Waiting' : 'Your move', waiting.length], ['disputes', 'Disputes', disputes.length], ['closed', 'Closed', closed.length]] as const).map(([value, label, n]) => (
                <TabsTrigger key={value} value={value} className="h-9 shrink-0 rounded-[8px] px-2.5 text-[13px] data-active:bg-ink data-active:text-white sm:px-3.5">
                  {label}<span className="mono ml-1.5 text-[11px] opacity-60">{n}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Reveal>

        {contracts.error ? <ErrorNote>{contracts.error}</ErrorNote> : null}
        {contracts.loading && !contracts.data ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[150px] rounded-[16px] bg-white/60" />)}</div> : null}
        {contracts.data && shown.length === 0 ? <Empty title="Nothing here">No milestones match this filter.</Empty> : null}

        <Stagger as="ul" className="space-y-3.5" key={`${filter}-${lens}`}>
          {shown.map((r) => {
            const {contract: c, milestone: m} = r
            const mine = yourMove(r)
            return (
              <StaggerItem as="li" key={m.id}>
                <Link to={`/contracts/${c.id}`} className="group block">
                  <SpotlightCard spotlightColor="rgba(255, 212, 0, 0.16)" className={cn('surface rounded-[16px] p-5 transition-[transform,box-shadow] duration-300 group-hover:-translate-y-0.5 group-hover:shadow-[0_28px_60px_-28px_rgb(11_14_15/0.45)] sm:p-6', mine && 'ring-spin')}>
                    <div className="relative flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StateTag state={m.state} />
                          {c.mode === 'paper' ? <SimTag /> : <Tag tone="blue">Live</Tag>}
                          {mine ? <Tag className="bg-yellow text-ink">Your move</Tag> : null}
                          <span className="mono text-[10.5px] text-ink-3">{c.id.slice(0, 8)}</span>
                        </div>
                        <h3 className="mt-3.5 truncate font-[family-name:var(--font-display)] text-[17px] font-medium tracking-[-0.02em]">{m.title}</h3>
                        <p className="mt-1.5 truncate text-[13.5px] text-ink-3">
                          <span className="text-ink-2">{c.buyer.displayName}</span> → <span className="text-ink-2">{c.seller.displayName}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-3 md:flex-col md:items-end md:gap-2">
                        <Amount display={m.amount.display} className="display text-[24px]" />
                        <span className="hidden size-8 place-items-center rounded-[8px] border border-ink/10 bg-white/70 text-ink-3 transition-colors group-hover:bg-ink group-hover:text-white md:grid"><ArrowUpRight className="size-4" /></span>
                      </div>
                    </div>
                    <div className="relative mt-5 grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:items-end">
                      <StageTrack state={m.state} terminal={m.terminal} />
                      <div className="text-[13px] md:text-right">
                        {acts(r) ? (
                          <>
                            <p><span className="font-semibold capitalize">{m.next!.actor}</span><span className="text-ink-2"> · {m.next!.action}</span></p>
                            {m.next!.dueAt ? <p className="mt-0.5 text-ink-3">by {dateTime(m.next!.dueAt.ms)} · <Countdown ms={m.next!.dueAt.ms} /></p> : null}
                          </>
                        ) : (
                          <p className="text-ink-3">Closed{m.outcome ? ` · ${m.outcome.charAt(0)}${m.outcome.slice(1).toLowerCase()}` : ''}</p>
                        )}
                      </div>
                    </div>
                  </SpotlightCard>
                </Link>
              </StaggerItem>
            )
          })}
        </Stagger>
        {rows.length ? <p className="mono pt-2 text-[11px] text-ink-3">{rows.length} milestones · {usdm(rows.reduce((s, r) => s + BigInt(r.milestone.amount.atomic), 0n))} test USDM under contract</p> : null}
      </div>
    </div>
  )
}
