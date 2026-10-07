import {useEffect, useState} from 'react'
import {Link, useSearchParams} from 'react-router-dom'
import {ArrowUpRight, FileSignature, Scale} from 'lucide-react'
import {EvidenceList} from '@/components/Evidence'
import {Reveal, Stagger, StaggerItem} from '@/components/motion'
import {Amount, Countdown, Empty, ErrorNote, Hash, KV, PageHeader, Section, SimTag, StateTag, Tag} from '@/components/kit'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Label} from '@/components/ui/label'
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group'
import {Skeleton} from '@/components/ui/skeleton'
import {Textarea} from '@/components/ui/textarea'
import {api, type Role, type RulingOption, type RulingPayload} from '@/lib/api'
import {ACTION_LABEL, dateTime, pct, pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

function RulingCompare({options, defaultWinner}: {options: RulingOption[]; defaultWinner: Role}) {
  const rows: Array<[string, (o: RulingOption) => React.ReactNode]> = [
    ['To the seller', (o) => <Amount display={o.payout.toSeller.display} className="font-semibold" />],
    ['To the buyer', (o) => <Amount display={o.payout.toBuyer.display} className="font-semibold" />],
    ['Escrows', (o) => <span className="text-ink-2">{o.escrowDecisions.map((d) => `${pretty(d.role)}: ${d.decision}`).join(' · ')}</span>],
    ['Dispute fee', (o) => (o.fee ? <span><Amount display={o.fee.amount.display} />, paid by the {o.fee.paidBy}</span> : 'None')],
    ['Obligations', (o) => (
      <ul className="space-y-1">{o.obligations.map((ob) => <li key={ob.party + ob.action}><span className="capitalize">{ob.party}</span>: {ACTION_LABEL[ob.action] ?? pretty(ob.action)} <span className="text-ink-3">by {dateTime(ob.dueAt.ms)}</span></li>)}</ul>
    )],
    ['Reliability record', (o) => (
      <span>{o.reliabilityIfSettled.state === 'failed' ? <Tag tone="down">Failed</Tag> : <Tag tone="up">Successful</Tag>}<span className="ml-2 text-ink-3">{!o.reliabilityIfSettled.fault || o.reliabilityIfSettled.fault === 'none' ? 'no one at fault' : `${o.reliabilityIfSettled.fault} at fault`} · {pct(o.reliabilityIfSettled.verificationConfidence)}</span></span>
    )],
  ]
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)] text-[13.5px]">
        <div />
        {options.map((o) => (
          <div key={o.winner} className={cn('rounded-t-[10px] px-4 pb-3 pt-3', o.winner === defaultWinner && 'bg-yellow-wash')}>
            <p className="font-semibold">{o.winner === 'buyer' ? 'Buyer wins' : 'Seller wins'}</p>
            {o.winner === defaultWinner ? <p className="text-[11.5px] text-ink-3">Also the default if nobody rules</p> : null}
          </div>
        ))}
        {rows.map(([label, cell]) => (
          <div key={label} className="contents">
            <div className="border-t border-border py-3 pr-3 text-ink-3">{label}</div>
            {options.map((o) => <div key={o.winner} className={cn('border-t border-border px-4 py-3', o.winner === defaultWinner && 'bg-yellow-wash/60')}>{cell(o)}</div>)}
          </div>
        ))}
      </div>
    </div>
  )
}

function PrepareRuling({contractId, canRule}: {contractId: string; canRule: boolean}) {
  const [winner, setWinner] = useState<Role>('buyer')
  const [reason, setReason] = useState('')
  const [payload, setPayload] = useState<RulingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const prepare = async () => {
    setBusy(true); setError(null)
    try { setPayload(await api.rulingPayload(contractId, 0, winner, reason.trim())) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <Section title="Prepare a ruling" aside="Tally drafts. The mediator signs.">
      <div className="space-y-5">
        <RadioGroup value={winner} onValueChange={(v) => setWinner(v as Role)} className="flex gap-6">
          {(['buyer', 'seller'] as const).map((r) => (
            <Label key={r} className="flex cursor-pointer items-center gap-2 text-[14px] font-medium"><RadioGroupItem value={r} />{r === 'buyer' ? 'Buyer wins' : 'Seller wins'}</Label>
          ))}
        </RadioGroup>
        <div className="space-y-2">
          <Label htmlFor="reason" className="text-[13px] text-ink-2">Reason, signed and shown to both parties</Label>
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lab report shows 15.9% moisture against a 12.5% limit." className="min-h-24 bg-white" />
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={prepare} disabled={!canRule || !reason.trim() || busy} className="h-10 rounded-[9px] px-4"><FileSignature className="size-4" />Prepare the bytes to sign</Button>
          {!canRule ? <span className="text-[12.5px] text-ink-3">Only a Tier 3 case can be ruled on.</span> : null}
        </div>
      </div>
      <Dialog open={!!payload} onOpenChange={(open) => { if (!open) setPayload(null) }}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl bg-gradient-to-b from-white to-[#f0f1f2]">
          <DialogHeader>
            <DialogTitle>Ruling bytes for the mediator</DialogTitle>
            <DialogDescription>The mediator signs these exact bytes with their own key, outside Tally. Tally never holds the mediator key.</DialogDescription>
          </DialogHeader>
          {payload ? (
            <div className="space-y-4">
              <div>
                <p className="eyebrow mb-2">Bytes to sign</p>
                <pre className="mono max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-border bg-white p-4 text-[12px] leading-relaxed">{payload.bytes}</pre>
                <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-3"><span className="eyebrow">sha-256</span><Hash value={payload.bytesSha256} /></p>
              </div>
              <div>
                <p className="eyebrow mb-2">Then send · <span className="normal-case tracking-normal">{payload.endpoint}</span></p>
                <pre className="mono max-h-[24vh] overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-border bg-white p-4 text-[12px] leading-relaxed">{JSON.stringify(payload.request, null, 2)}</pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Section>
  )
}

export function MediationPage() {
  const disputes = useAsync(() => api.contracts({disputes: true}).then((list) => [...list].sort((a, b) => b.milestones[0].tierReached - a.milestones[0].tierReached)), 'disputes')
  const [params, setParams] = useSearchParams()
  const selected = params.get('case') ?? disputes.data?.[0]?.id ?? null
  const kase = useAsync(() => (selected ? api.disputeCase(selected, 0) : Promise.resolve(null)), `mcase-${selected}`)
  const options = useAsync(() => (selected ? api.rulingOptions(selected, 0) : Promise.resolve(null)), `mopts-${selected}`)

  useEffect(() => { window.scrollTo({top: 0}) }, [selected])

  const list = disputes.data ?? []
  const k = kase.data
  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Mediation" title="Mediation desk" description="Disputes that reached a person. Each case shows the evidence both sides submitted and the engine's simulation of both rulings, before anyone signs." />

      {disputes.error ? <ErrorNote>{disputes.error}</ErrorNote> : null}
      {disputes.data && list.length === 0 ? <Empty title="No open disputes">Every milestone is moving without a mediator.</Empty> : null}

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Stagger className="space-y-2.5 xl:sticky xl:top-8 xl:self-start" key={list.length}>
          {disputes.loading && !disputes.data ? <Skeleton className="h-28 rounded-[12px] bg-white/70" /> : null}
          {list.map((c) => {
            const m = c.milestones[0]
            const active = c.id === selected
            return (
              <StaggerItem key={c.id}><button type="button" onClick={() => setParams({case: c.id})} className={cn('surface block w-full rounded-[12px] p-4 text-left transition-shadow', active ? 'ring-2 ring-ink' : 'hover:shadow-[0_10px_28px_-14px_rgb(11_14_15/0.3)]')}>
                <div className="flex items-center justify-between gap-2"><StateTag state={m.state} /><SimTag /></div>
                <p className="mt-2.5 text-[14px] font-semibold leading-snug">{m.title}</p>
                <p className="mt-1 text-[12.5px] text-ink-3">{c.buyer.displayName} vs {c.seller.displayName}</p>
                {m.next?.dueAt && m.next.actor !== 'none' ? <p className="mt-2 text-[12px] text-ink-2">{m.next.action} · <Countdown ms={m.next.dueAt.ms} /></p> : null}
              </button></StaggerItem>
            )
          })}
        </Stagger>

        <div className="min-w-0 space-y-6">
          {kase.error ? <ErrorNote>{kase.error}</ErrorNote> : null}
          {selected && !k ? <Skeleton className="h-96 rounded-[16px] bg-white/70" /> : null}
          {k ? (
            <>
              <Section>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><Scale className="size-4 text-blue" /><span className="eyebrow">Tier {k.milestone.dispute?.tierReached ?? 0} reached</span></div>
                    <h2 className="display mt-2 text-[24px]">{k.milestone.title}</h2>
                    <p className="mt-2 text-[13.5px] text-ink-2">{k.nextStep}</p>
                  </div>
                  <Link to={`/contracts/${k.contract.id}`} className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-blue hover:underline">Full contract<ArrowUpRight className="size-3.5" /></Link>
                </div>
                <KV className="mt-5" rows={[
                  ['Amount', <Amount key="a" display={k.milestone.amount.display} />],
                  ['Judge', k.contract.judge],
                  ['Remedy', k.contract.remedy],
                  ['Delivered on time', k.milestone.deliveredOnTime === null ? '—' : k.milestone.deliveredOnTime ? 'Yes' : 'No'],
                  ...(k.milestone.dispute?.tierDeadline ? [['Tier deadline', <span key="d">{dateTime(k.milestone.dispute.tierDeadline.ms)} · <Countdown ms={k.milestone.dispute.tierDeadline.ms} /></span>] as [string, React.ReactNode]] : []),
                ]} />
              </Section>

              {options.data ? (
                <Reveal><Section title="What each ruling does" aside="Simulated by the engine on a copy of the contract">
                  <RulingCompare options={options.data.options} defaultWinner={options.data.defaultIfNoRuling.winner} />
                </Section></Reveal>
              ) : options.error ? (
                <Section title="What each ruling does">
                  <p className="text-[13.5px] leading-relaxed text-ink-2">A mediator rules only at Tier 3. Until then the parties can settle by signing one fixed outcome together: full release, core only, or full refund. If they miss the tier deadline, the dispute moves up a tier.</p>
                </Section>
              ) : null}

              <Reveal><Section title="Evidence"><EvidenceList kase={k} /></Section></Reveal>

              {k.canRuleNow ? <Reveal><div className="ring-spin rounded-[14px]"><PrepareRuling contractId={k.contract.id} canRule /></div></Reveal> : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
