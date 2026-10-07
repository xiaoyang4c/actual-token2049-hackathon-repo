import {useMemo, useState} from 'react'
import {Search} from 'lucide-react'
import {Empty, ErrorNote, Hash, KV, PageHeader, Section, Tag} from '@/components/kit'
import {Reveal} from '@/components/motion'
import {Input} from '@/components/ui/input'
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from '@/components/ui/sheet'
import {Skeleton} from '@/components/ui/skeleton'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {api, type Entity, type LedgerTransaction, type Receipt} from '@/lib/api'
import {dateTime, day, pct, pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'

type View = 'transactions' | 'attention' | 'participants' | 'listings'

const OUTCOME_TONE: Record<string, 'up' | 'warn' | 'down' | 'quiet' | 'blue'> = {
  successful: 'up', pending: 'warn', failed: 'down', disputed: 'warn', cancelled: 'quiet', unresolved: 'down',
}

const itemOf = (t: LedgerTransaction) => String(t.terms.goods ?? t.terms.service ?? t.terms.invoice ?? t.terms.title ?? t.id)
const outcomeOf = (r: Receipt | undefined) => r?.outcome?.state ?? 'unknown'

function load() {
  return Promise.all([api.transactions(), api.entities(), api.scores(), api.listings()]).then(async ([transactions, entities, scores, listings]) => {
    // One receipt per transaction, for its outcome and evidence. A missing receipt reads as unknown.
    const receipts = await Promise.all(transactions.map((t) => api.receipt(t.id).catch(() => null)))
    return {transactions, entities, scores, listings, receipts: new Map(transactions.map((t, i) => [t.id, receipts[i] ?? undefined]))}
  })
}

function ReceiptSheet({receipt, names, onClose}: {receipt: Receipt | null; names: Map<string, string>; onClose: () => void}) {
  const t = receipt?.transaction
  return (
    <Sheet open={!!receipt} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-gradient-to-b from-white to-[#e6e8eb] p-0 sm:max-w-lg">
        {t ? (
          <>
            <SheetHeader className="border-b border-border p-6">
              <p className="eyebrow">Receipt</p>
              <SheetTitle className="display text-[22px]">{itemOf(t)}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Tag tone={OUTCOME_TONE[outcomeOf(receipt!)] ?? 'quiet'}>{pretty(outcomeOf(receipt!))}</Tag>
                <span className="mono text-[11.5px]">{t.id}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-6 p-6">
              <KV rows={[
                ['Type', pretty(t.type)],
                ['Value', <span key="v" className="num">{t.value.toLocaleString('en-US')}</span>],
                ...t.participants.map((p) => [pretty(p.role), names.get(p.entityId) ?? p.entityId] as [string, string]),
                ['Created', day(t.createdAt)],
                ['Completed', t.completedAt ? day(t.completedAt) : 'Open'],
              ]} />
              {receipt!.outcome ? (
                <div>
                  <p className="eyebrow mb-2.5">Outcome evidence</p>
                  <KV rows={[
                    ['Method', pretty(receipt!.outcome.verificationMethod)],
                    ['Confidence', pct(receipt!.outcome.verificationConfidence)],
                    ['At fault', pretty(receipt!.outcome.fault ?? 'none')],
                    ...Object.entries(receipt!.outcome.evidence).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [pretty(k.replace(/([A-Z])/g, ' $1').toLowerCase()), typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? dateTime(v) : typeof v === 'string' && v.length > 24 ? <Hash key={k} value={v} n={8} /> : String(v)] as [string, React.ReactNode]),
                  ]} />
                </div>
              ) : <p className="text-[13.5px] text-ink-3">No recorded outcome yet.</p>}
              {receipt!.events.length ? (
                <div>
                  <p className="eyebrow mb-2.5">Score events</p>
                  <ul className="space-y-2 text-[13px]">
                    {receipt!.events.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-3 rounded-[8px] bg-white/70 px-3 py-2">
                        <span>{names.get(e.entityId) ?? e.entityId} <span className="text-ink-3">· {e.role} · {pretty(e.category)}</span></span>
                        <Tag tone={e.outcome === 'success' ? 'up' : 'down'}>{pretty(e.outcome)}</Tag>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {receipt!.termsDecision ? (
                <div>
                  <p className="eyebrow mb-2.5">Fee offer · {names.get(receipt!.termsDecision.entityId) ?? receipt!.termsDecision.entityId}</p>
                  <KV rows={[
                    ['Buyer fee', `${(receipt!.termsDecision.buyerFeeBps / 100).toFixed(2)}%`],
                    ['Seller fee', `${(receipt!.termsDecision.sellerFeeBps / 100).toFixed(2)}%`],
                    ['Reason', pretty(receipt!.termsDecision.reasonCode.toLowerCase())],
                    ['Policy', <span key="p" className="mono text-[12px]">{receipt!.termsDecision.policyVersion}</span>],
                  ]} />
                  <p className="mt-2 text-[11.5px] text-ink-3">A policy offer for this entity, not a recorded charge.</p>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

export function OperatorPage() {
  const data = useAsync(load, 'operator')
  const [view, setView] = useState<View>('transactions')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Receipt | null>(null)

  const names = useMemo(() => new Map((data.data?.entities ?? []).map((e) => [e.id, e.displayName])), [data.data])
  const match = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase())

  const d = data.data
  const transactions = (d?.transactions ?? []).filter((t) => !query || match(`${t.id} ${itemOf(t)} ${t.participants.map((p) => names.get(p.entityId) ?? p.entityId).join(' ')}`))
  const attentionTx = transactions.filter((t) => !['successful', 'cancelled'].includes(outcomeOf(d?.receipts.get(t.id))))
  const attentionKyc = (d?.entities ?? []).filter((e) => e.kycStatus !== 'verified' && (!query || match(`${e.id} ${e.displayName}`)))
  const participants = (d?.entities ?? []).filter((e) => !query || match(`${e.id} ${e.displayName}`))
  const listings = (d?.listings ?? []).filter((l) => !query || match(`${l.title} ${names.get(l.sellerId) ?? l.sellerId}`))

  const txTable = (rows: LedgerTransaction[]) => rows.length ? (
    <Table>
      <TableHeader><TableRow><TableHead className="pl-5">Transaction</TableHead><TableHead>Counterparties</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Outcome</TableHead><TableHead className="pr-5">Mode</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((t) => {
          const r = d?.receipts.get(t.id)
          return (
            <TableRow key={t.id} className="cursor-pointer" onClick={() => r && setOpen(r)}>
              <TableCell className="pl-5"><p className="max-w-[18rem] truncate font-medium">{itemOf(t)}</p><p className="mono text-[11px] text-ink-3">{t.id} · {pretty(t.type)}</p></TableCell>
              <TableCell className="text-[12.5px] text-ink-2">{t.participants.map((p) => names.get(p.entityId) ?? p.entityId).join(' → ')}</TableCell>
              <TableCell className="num text-right">{t.value.toLocaleString('en-US')}</TableCell>
              <TableCell><Tag tone={OUTCOME_TONE[outcomeOf(r)] ?? 'quiet'}>{pretty(outcomeOf(r))}</Tag></TableCell>
              <TableCell className="pr-5"><span className="mono text-[11px] text-ink-3">{String(r?.outcome?.evidence.mode ?? 'paper').toUpperCase()}</span></TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  ) : <div className="p-5"><Empty title="Nothing to show">No transactions match.</Empty></div>

  const kycTone = (e: Entity) => (e.kycStatus === 'verified' ? 'up' : e.kycStatus === 'pending' ? 'warn' : 'down')

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Operator" title="The marketplace ledger" description="Every recorded transaction with its receipt, the outcomes that need a look, participants with their scores and KYC, and listings. Read-only." />
      {data.error ? <ErrorNote>{data.error}</ErrorNote> : null}

      <Reveal>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList className="h-auto flex-wrap gap-0.5 rounded-[11px] border border-white/70 bg-white/45 p-1 backdrop-blur-md">
              {([['transactions', 'Transactions', transactions.length], ['attention', 'Needs attention', attentionTx.length + attentionKyc.length], ['participants', 'Participants', participants.length], ['listings', 'Listings', listings.length]] as const).map(([value, label, n]) => (
                <TabsTrigger key={value} value={value} className="h-9 shrink-0 rounded-[8px] px-2.5 text-[13px] data-active:bg-ink data-active:text-white sm:px-3.5">
                  {label}<span className="mono ml-1.5 text-[11px] opacity-60">{n}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative sm:w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions or participants" className="h-10 bg-white/80 pl-9" />
          </div>
        </div>
      </Reveal>

      {data.loading && !d ? <Skeleton className="h-96 rounded-[16px] bg-white/60" /> : null}

      {d && view === 'transactions' ? <Reveal><Section bodyClassName="p-0" title="Transactions" aside="Select a row for its receipt">{txTable(transactions)}</Section></Reveal> : null}

      {d && view === 'attention' ? (
        <div className="space-y-6">
          <Reveal><Section bodyClassName="p-0" title="Outcomes to review" aside="Pending, failed, disputed, unresolved and unknown">{txTable(attentionTx)}</Section></Reveal>
          <Reveal>
            <Section title="KYC to review" bodyClassName="p-0">
              {attentionKyc.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead className="pl-5">Participant</TableHead><TableHead>KYC</TableHead><TableHead className="pr-5">Tier</TableHead></TableRow></TableHeader>
                  <TableBody>{attentionKyc.map((e) => <TableRow key={e.id}><TableCell className="pl-5 font-medium">{e.displayName}<p className="mono text-[11px] text-ink-3">{e.id}</p></TableCell><TableCell><Tag tone={kycTone(e)}>{pretty(e.kycStatus)}</Tag></TableCell><TableCell className="pr-5 text-ink-2">{pretty(e.kycTier)}</TableCell></TableRow>)}</TableBody>
                </Table>
              ) : <div className="p-5"><Empty title="All participants verified" /></div>}
            </Section>
          </Reveal>
        </div>
      ) : null}

      {d && view === 'participants' ? (
        <div className="grid gap-4 md:grid-cols-2">
          {participants.map((e, i) => {
            const scores = d.scores.filter((s) => s.entityId === e.id)
            return (
              <Reveal key={e.id} delay={Math.min(i, 6) * 0.04}>
                <Section>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate font-[family-name:var(--font-display)] text-[15px]">{e.displayName}</p><p className="mono text-[11px] text-ink-3">{e.id}</p></div>
                    <Tag tone={kycTone(e)}>KYC {e.kycStatus}{e.kycTier !== 'none' ? ` · ${e.kycTier}` : ''}</Tag>
                  </div>
                  {scores.length ? (
                    <ul className="mt-4 space-y-2.5">
                      {scores.map((s) => (
                        <li key={s.category + s.role} className="text-[12.5px]">
                          <div className="flex justify-between"><span>{pretty(s.category)} <span className="text-ink-3">as {s.role}</span></span><span className="num text-ink-2">{pct(s.lowerBound)} lower bound · {s.eventCount} events</span></div>
                          <div className="relative mt-1.5 h-1.5 rounded-[2px] bg-black/[0.07]"><div className="absolute inset-y-0 left-0 rounded-[2px] bg-gradient-to-r from-ink to-blue" style={{width: pct(Math.max(s.lowerBound, 0.01))}} /></div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-4 text-[12.5px] text-ink-3">No scores yet.</p>}
                </Section>
              </Reveal>
            )
          })}
        </div>
      ) : null}

      {d && view === 'listings' ? (
        <Reveal>
          <Section bodyClassName="p-0" title="Listings">
            <Table>
              <TableHeader><TableRow><TableHead className="pl-5">Listing</TableHead><TableHead>Seller</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Min. seller score</TableHead><TableHead className="pr-5">Required terms</TableHead></TableRow></TableHeader>
              <TableBody>
                {listings.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="pl-5"><p className="max-w-[18rem] truncate font-medium">{l.title}</p><p className="mono text-[11px] text-ink-3">{l.id} · {pretty(l.transactionType)}</p></TableCell>
                    <TableCell className="text-ink-2">{names.get(l.sellerId) ?? l.sellerId}</TableCell>
                    <TableCell className="num text-right">{l.price === null ? 'Quote' : l.price.toLocaleString('en-US')}</TableCell>
                    <TableCell className="num">{pct(l.minSellerReliability)}</TableCell>
                    <TableCell className="pr-5 text-[12px] text-ink-3">{Object.entries(l.requiredTerms).map(([k, v]) => `${pretty(k.replace(/([A-Z])/g, ' $1').toLowerCase())}: ${typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? day(v) : String(v)}`).join(' · ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </Reveal>
      ) : null}

      <ReceiptSheet receipt={open} names={names} onClose={() => setOpen(null)} />
    </div>
  )
}
