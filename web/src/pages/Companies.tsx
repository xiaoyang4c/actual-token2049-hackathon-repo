import {useEffect, useMemo, useState} from 'react'
import {Link, useSearchParams} from 'react-router-dom'
import {ArrowUpRight, Building2, Search} from 'lucide-react'
import {motion} from 'motion/react'
import {Amount, Empty, ErrorNote, PageHeader, Section, StateTag, Tag} from '@/components/kit'
import {Reveal, Stagger, StaggerItem} from '@/components/motion'
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from '@/components/ui/command'
import {Skeleton} from '@/components/ui/skeleton'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'
import {api, type EntityHit, type Profile, type RecordCounts} from '@/lib/api'
import {day, pct, pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const COUNTS: Array<[keyof RecordCounts, string]> = [
  ['milestones', 'Milestones'], ['open', 'Open'], ['disputed', 'Disputed'], ['disputesLost', 'Disputes lost'],
  ['rulingsIgnored', 'Rulings ignored'], ['lateDeliveries', 'Late deliveries'], ['atFault', 'At fault'],
]

function Finder({onPick}: {onPick: (id: string) => void}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<EntityHit[]>([])
  const known = useAsync(() => api.contracts(), 'contracts-all')
  const parties = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of known.data ?? []) { seen.set(c.buyer.id, c.buyer.displayName); seen.set(c.seller.id, c.seller.displayName) }
    return [...seen.entries()]
  }, [known.data])

  useEffect(() => {
    if (query.trim().length < 2) return
    const id = setTimeout(() => { api.search(query.trim()).then(setHits).catch(() => setHits([])) }, 180)
    return () => clearTimeout(id)
  }, [query])

  return (
    <Command shouldFilter={false} className="surface rounded-[14px] bg-transparent">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Company name or Tally id" className="h-12 text-[15px]" />
      <CommandList className="max-h-[320px]">
        {query.trim().length >= 2 ? (
          <>
            <CommandEmpty>No company on Tally matches “{query}”.</CommandEmpty>
            <CommandGroup heading="Results">
              {hits.map((h) => (
                <CommandItem key={h.id} value={h.id} onSelect={() => onPick(h.id)} className="flex items-start gap-2.5 rounded-[8px] py-2.5">
                  <Building2 className="mt-0.5 size-4 text-ink-3" />
                  <span className="min-w-0"><span className="block">{h.displayName}</span><span className="mono block text-[11px] text-ink-3">{h.id}</span></span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : (
          <CommandGroup heading="Trading on Tally">
            {parties.map(([id, name]) => (
              <CommandItem key={id} value={id} onSelect={() => onPick(id)} className="flex items-start gap-2.5 rounded-[8px] py-2.5">
                <Building2 className="mt-0.5 size-4 text-ink-3" />
                <span className="min-w-0"><span className="block">{name}</span><span className="mono block text-[11px] text-ink-3">{id}</span></span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}

function Record({p, names}: {p: Profile; names: Map<string, string>}) {
  return (
    <div className="space-y-6">
      <Reveal><section className="surface rounded-[18px] p-6 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="eyebrow">{p.entity.id}</p>
            <h2 className="display text-gradient mt-3 text-[30px] sm:text-[40px]">{p.entity.displayName}</h2>
            <p className="mt-3 text-[13.5px] text-ink-2">On Tally since {day(p.entity.createdAt)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Tag tone={p.entity.kycStatus === 'verified' ? 'up' : p.entity.kycStatus === 'pending' ? 'warn' : 'quiet'}>KYC {p.entity.kycStatus}</Tag>
            {p.entity.kycTier !== 'none' ? <Tag tone="blue">{pretty(p.entity.kycTier)} tier</Tag> : null}
          </div>
        </div>
        <Stagger className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] bg-border sm:grid-cols-4 lg:grid-cols-7">
          {COUNTS.map(([key, label]) => {
            const live = p.contractSummary.live[key], sim = p.contractSummary.simulated[key]
            const bad = (key === 'disputesLost' || key === 'atFault' || key === 'rulingsIgnored' || key === 'lateDeliveries') && live + sim > 0
            return (
              <StaggerItem key={key} className="bg-white/90 px-4 py-4">
                <p className="text-[12px] text-ink-3">{label}</p>
                <p className={cn('display mt-2 text-[26px] leading-none', bad && 'text-down')}>{live + sim}</p>
                <p className="mt-1.5 text-[11px] text-ink-3">{live} live · {sim} simulated</p>
              </StaggerItem>
            )
          })}
        </Stagger>
      </section></Reveal>

      <Reveal className="grid gap-6 lg:grid-cols-2">
        <Section title="Scores" aside={p.scoringPolicy.provisional ? `${p.scoringPolicy.version}, provisional` : p.scoringPolicy.version}>
          {p.scores.length ? (
            <ul className="space-y-5">
              {p.scores.map((s) => (
                <li key={s.category + s.role}>
                  <div className="flex items-baseline justify-between">
                    <p className="text-[14px] font-medium">{pretty(s.category)} <span className="text-ink-3">as {s.role}</span></p>
                    <p className="num text-[13px] text-ink-2">{s.events.success ?? 0} ok · {s.events.failure ?? 0} failed</p>
                  </div>
                  <div className="relative mt-2.5 h-2 rounded-[2px] bg-black/[0.07]">
                    <motion.div className="absolute inset-y-0 left-0 rounded-[2px] bg-gradient-to-r from-ink to-blue" initial={{width: 0}} whileInView={{width: pct(Math.max(s.lowerBound, 0.01))}} viewport={{once: true}} transition={{duration: 1.1, ease: [0.22, 1, 0.36, 1]}} />
                    <div className="absolute -top-1 h-4 w-[2px] bg-blue" style={{left: pct(s.score)}} title="Average" />
                  </div>
                  <p className="mt-2 text-[12px] text-ink-3">Lower bound <span className="num text-ink-2">{pct(s.lowerBound)}</span> · average <span className="num text-ink-2">{pct(s.score, 1)}</span> · confidence <span className="num text-ink-2">{pct(s.confidence)}</span></p>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13.5px] text-ink-3">No closed milestones yet.</p>}
          <p className="mt-5 text-[11.5px] leading-snug text-ink-3">Read these as counts of successes and failures. The scoring policy is a placeholder, not a calibrated rating.</p>
        </Section>

        <Section title="Fee offers" aside="Policy offers, not charges">
          {p.termsDecisions.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-right">Buyer fee</TableHead><TableHead className="text-right">Seller fee</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody>
                {p.termsDecisions.map((t) => (
                  <TableRow key={t.category}>
                    <TableCell>{pretty(t.category)}</TableCell>
                    <TableCell className="num text-right">{(t.buyerFeeBps / 100).toFixed(2)}%</TableCell>
                    <TableCell className="num text-right">{(t.sellerFeeBps / 100).toFixed(2)}%</TableCell>
                    <TableCell className="text-[12.5px] text-ink-3">{pretty(t.reasonCode.toLowerCase()).replace(/^Kyc/, 'KYC')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <p className="text-[13.5px] text-ink-3">No fee decision recorded yet.</p>}
        </Section>
      </Reveal>

      <Reveal><Section title="Deals" aside="Tally deals only. Information, not a credit rating." bodyClassName="p-0">
        <Table>
          <TableHeader><TableRow><TableHead className="pl-5">Counterparty</TableHead><TableHead>Role</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>State</TableHead><TableHead className="hidden md:table-cell">Dispute</TableHead><TableHead className="pr-5" /></TableRow></TableHeader>
          <TableBody>
            {p.deals.map((d) => (
              <TableRow key={d.contractId + d.milestoneIndex}>
                <TableCell className="pl-5 font-medium">{names.get(d.counterpartyId) ?? d.counterpartyId}</TableCell>
                <TableCell className="capitalize text-ink-2">{d.role}</TableCell>
                <TableCell className="text-right"><Amount display={d.amount.display} /></TableCell>
                <TableCell><StateTag state={d.state} /></TableCell>
                <TableCell className="hidden text-[12.5px] text-ink-2 md:table-cell">{d.disputed ? `Tier ${d.disputeTierReached}${d.disputeWinner ? `, ${d.disputeWinner} won` : ', open'}` : '—'}</TableCell>
                <TableCell className="pr-5 text-right"><Link to={`/contracts/${d.contractId}`} aria-label="Open contract" className="inline-flex rounded-[6px] p-1.5 text-ink-3 hover:bg-black/[0.05] hover:text-ink"><ArrowUpRight className="size-4" /></Link></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section></Reveal>
    </div>
  )
}

export function CompaniesPage() {
  const [params, setParams] = useSearchParams()
  const id = params.get('id')
  const profile = useAsync(() => (id ? api.profile(id) : Promise.resolve(null)), `profile-${id}`)
  const all = useAsync(() => api.contracts(), 'contracts-all')
  const names = useMemo(() => new Map((all.data ?? []).flatMap((c) => [[c.buyer.id, c.buyer.displayName], [c.seller.id, c.seller.displayName]] as [string, string][])), [all.data])

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Companies" title="Check a company before you deal" description="A company's Tally record: what it has funded, delivered, disputed and lost. The same numbers the Trust Check Coworker reads." />
      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="xl:sticky xl:top-8 xl:self-start"><Finder onPick={(pick) => setParams({id: pick})} /></div>
        <div className="min-w-0">
          {!id ? <Empty title="Pick a company"><Search className="mr-1 inline size-3.5" />Search by name, or choose one of the companies trading on Tally.</Empty> : null}
          {profile.error ? <ErrorNote>{profile.error}</ErrorNote> : null}
          {id && !profile.data && !profile.error ? <Skeleton className="h-96 rounded-[18px] bg-white/70" /> : null}
          {profile.data ? <Record p={profile.data} names={names} /> : null}
        </div>
      </div>
    </div>
  )
}
