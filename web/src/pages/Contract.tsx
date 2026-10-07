import {useState, type ReactNode} from 'react'
import {Link, useParams} from 'react-router-dom'
import {BlockChain, FundsFlow, Reveal} from '@/components/motion'
import {ArrowLeft, Gavel, ShieldCheck, ShieldX} from 'lucide-react'
import {ContractAnchorList} from '@/components/Anchors'
import {EvidenceList} from '@/components/Evidence'
import {Amount, Countdown, ErrorNote, Hash, KV, Section, SimTag, StageTrack, StateTag, Tag} from '@/components/kit'
import {Skeleton} from '@/components/ui/skeleton'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'
import {api, type AuditRow, type ContractView, type DisputeCase, type ContractSummary, type ContractAnchors} from '@/lib/api'
import {ACTION_LABEL, REMEDY_LABEL, dateTime, pct, pretty, usdm} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'

function AuditTrail({rows, intact}: {rows: AuditRow[]; intact: boolean}) {
  const [all, setAll] = useState(false)
  return (
    <section>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Append-only</p>
          <h2 className="display mt-2 text-[22px]">Audit chain</h2>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${intact ? 'text-up' : 'text-down'}`}>{intact ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" />}{intact ? `${rows.length} blocks, hash chain intact` : 'Hash chain broken'}</span>
      </div>
      <BlockChain rows={all ? rows : rows.slice(0, 8)} intact={intact} />
      {rows.length > 8 ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-4 ml-9 inline-flex h-9 items-center rounded-[9px] border border-ink/10 bg-white/70 px-3.5 text-[13px] font-medium backdrop-blur hover:bg-white">
          {all ? 'Show the first 8 blocks' : `Show all ${rows.length} blocks`}
        </button>
      ) : null}
    </section>
  )
}

export function ContractPage() {
  const {id = ''} = useParams()
  const view = useAsync(() => api.contract(id), `view-${id}`)
  const kase = useAsync(() => api.disputeCase(id, 0), `case-${id}`)
  const audit = useAsync(() => api.audit(id), `audit-${id}`)
  const anchors = useAsync(() => api.contractAnchors(id), `anchors-${id}`)
  const summary = useAsync(() => api.contracts(), 'contracts-all').data?.find((c) => c.id === id)

  if (view.error) return <ErrorNote>{view.error}</ErrorNote>
  if (!view.data || !kase.data) return <div className="space-y-4"><Skeleton className="h-40 rounded-[16px] bg-white/70" /><Skeleton className="h-96 rounded-[16px] bg-white/70" /></div>

  return <ContractDetails view={view.data} kase={kase.data} audit={audit.data} anchors={anchors.data} anchorsError={anchors.error} summary={summary} />
}

/** Shared deal sections. App callers supply only session-gated data. */
export function ContractDetails({view: v, kase: k, audit, anchors, anchorsError, summary, milestoneIndex = 0, actions, privateDeal = false}: {
  view: ContractView; kase: DisputeCase; audit?: {rows: AuditRow[]; chainIntact: boolean} | null;
  anchors?: ContractAnchors | null; anchorsError?: string | null; summary?: ContractSummary;
  milestoneIndex?: number; actions?: ReactNode; privateDeal?: boolean
}) {
  const id = v.contract.id
  const m = v.milestones[milestoneIndex]
  const fault = m.reliability?.fault ?? 'none'
  const rawNext = summary?.milestones[milestoneIndex]?.next
  const next = rawNext && rawNext.actor !== 'none' ? rawNext : null
  const outcome = summary?.milestones[milestoneIndex]?.outcome
  const terms = v.contract.terms
  const buyer = summary?.buyer.displayName ?? terms.buyer.displayName ?? v.contract.buyerId
  const seller = summary?.seller.displayName ?? terms.seller.displayName ?? v.contract.sellerId
  const inT3 = k.milestone.state === 'tier_3_mediation'

  return (
    <div className="space-y-8">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink"><ArrowLeft className="size-4" />Deals</Link>

      <header className="surface rounded-[18px] p-6 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StateTag state={k.milestone.state} />
              {v.mode === 'paper' ? <SimTag /> : <Tag tone="blue">Live</Tag>}
              <span className="eyebrow ml-1">{v.contract.templateId}</span>
            </div>
            <h1 className="display text-gradient mt-4 text-[28px] sm:text-[42px]">{k.milestone.title}</h1>
            <p className="mt-3 text-[14.5px] text-ink-2"><span className="font-medium text-ink">{buyer}</span> (buyer) · <span className="font-medium text-ink">{seller}</span> (seller)</p>
          </div>
          <div className="shrink-0 lg:text-right">
            <p className="eyebrow">Milestone value</p>
            <Amount display={k.milestone.amount.display} className="display mt-2 block text-[38px]" />
          </div>
        </div>
        <div className="mt-8"><StageTrack state={k.milestone.state} terminal={summary?.milestones[milestoneIndex]?.terminal ?? false} /></div>
        <div className="mt-6 flex flex-col gap-3 rounded-[12px] bg-black/[0.035] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          {next ? (
            <p className="text-[14px]"><span className="font-semibold">Waiting for the {next.actor}</span><span className="text-ink-2"> · {next.action}</span>{next.dueAt ? <span className="text-ink-3"> · by {dateTime(next.dueAt.ms)}, <Countdown ms={next.dueAt.ms} /></span> : null}</p>
          ) : <p className="text-[14px] text-ink-2">{outcome ? <><span className="font-semibold text-ink">Closed</span> · {pretty(outcome.toLowerCase())}{m.reliability ? `, recorded as ${m.reliability.state}${fault !== 'none' ? ` with the ${fault} at fault` : ''}` : ''}.</> : k.nextStep}</p>}
          {inT3 && !privateDeal ? <Link to={`/mediation?case=${id}`} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] bg-ink px-3.5 text-[13px] font-semibold text-white hover:bg-ink-2"><Gavel className="size-4" />Open the case</Link> : null}
        </div>
      </header>

      <Reveal>
        <section className="surface-quiet rounded-[18px] p-5 sm:p-6">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div><p className="eyebrow">Money flow</p><h2 className="display mt-2 text-[22px]">Where the funds are</h2></div>
            <span className="mono hidden text-[11px] text-ink-3 sm:block">{terms.network} · test USDM · {v.mode}</span>
          </div>
          <FundsFlow escrows={m.escrows} buyer={buyer} seller={seller} />
        </section>
      </Reveal>

      {actions}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Reveal><Section title="Escrows" aside="One Masumi escrow per tranche">
            <Table>
              <TableHeader><TableRow><TableHead>Tranche</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Escrow state</TableHead><TableHead className="hidden sm:table-cell">Reference</TableHead></TableRow></TableHeader>
              <TableBody>
                {m.escrows.map((e) => (
                  <TableRow key={e.role}>
                    <TableCell className="font-medium capitalize">{e.role}</TableCell>
                    <TableCell className="num text-right">{usdm(e.amountAtomic)}</TableCell>
                    <TableCell><span className="num text-[12.5px]">{e.onChainState ?? 'Not funded'}</span>{e.confirmed ? <span className="ml-1.5 text-[11px] text-up">confirmed</span> : null}</TableCell>
                    <TableCell className="hidden sm:table-cell">{e.ref ? <Hash value={e.ref} n={5} /> : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section></Reveal>

          <Reveal><Section title="Evidence"><EvidenceList kase={k} /></Section></Reveal>

          {audit ? <AuditTrail rows={audit.rows} intact={audit.chainIntact} /> : null}
        </div>

        <div className="min-w-0 space-y-6">
          <Section title="Signed terms">
            <KV rows={[
              ['Judge', k.contract.judge],
              ['Remedy', REMEDY_LABEL[terms.remedy.type] ? `${REMEDY_LABEL[terms.remedy.type]}${terms.remedy.sellerShareBps ? `, seller keeps ${Number(terms.remedy.sellerShareBps) / 100}%` : ''}` : k.contract.remedy],
              ['No ruling by deadline', `${pretty(k.contract.tier3TimeoutWinner)} wins`],
              ['Network', `${terms.network} · test USDM`],
              ['Custody', v.custodyModel === 'platform_custodial_test_only' ? 'Platform test wallets' : v.custodyModel],
              ['Signatures', `${Object.keys(v.contract.signatures).length} of 2`],
              ['Terms hash', v.contract.termsSha256 ? <Hash key="h" value={v.contract.termsSha256} n={6} /> : 'Submit to freeze terms'],
            ]} />
          </Section>

          <Section title="Deadlines">
            {k.milestone.deadlines ? <KV rows={Object.entries(k.milestone.deadlines).map(([key, moment]) => [pretty(key.replace(/([A-Z])/g, ' $1').toLowerCase()), <span key={key}>{dateTime(moment.ms)} <span className="text-ink-3">· <Countdown ms={moment.ms} className="text-[12px]" /></span></span>])} /> : <p className="text-[13px] text-ink-3">Deadlines are set after both parties sign.</p>}
          </Section>

          {m.obligations.length ? (
            <Section title="Ruling obligations">
              <ul className="space-y-3 text-[13.5px]">
                {m.obligations.map((o) => (
                  <li key={o.party + o.action} className="flex items-start justify-between gap-3">
                    <span><span className="font-medium capitalize">{o.party}</span> · {ACTION_LABEL[o.action] ?? pretty(o.action)}<br /><span className="text-[12px] text-ink-3">due {dateTime(o.dueAt)}</span></span>
                    {o.compliedAt ? <Tag tone="up">Done</Tag> : o.ignoredAt ? <Tag tone="down">Ignored</Tag> : <Tag tone="warn">Open</Tag>}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="On-chain fingerprint" aside="Cardano preprod">
            {anchors ? <ContractAnchorList anchors={anchors} names={(entityId) => (entityId === v.contract.buyerId ? buyer : entityId === v.contract.sellerId ? seller : entityId)} /> : anchorsError ? <p className="text-[13px] text-ink-3">{anchorsError}</p> : <p className="text-[13px] text-ink-3">Loading…</p>}
          </Section>

          <Section title="Reliability record">
            {m.reliability ? (
              <KV rows={[
                ['Result', <Tag key="r" tone={m.reliability.state === 'successful' ? 'up' : m.reliability.state === 'failed' ? 'down' : 'quiet'}>{pretty(m.reliability.state)}</Tag>],
                ['At fault', pretty(fault)],
                ['Confidence', m.reliability.verificationConfidence !== undefined ? pct(m.reliability.verificationConfidence) : '—'],
                ['Record id', <span key="t" className="mono text-[12px]">{m.reliability.transactionId.split('/').pop()}</span>],
              ]} />
            ) : <p className="text-[13.5px] text-ink-3">Recorded when the milestone closes. It counts against the party at fault only.</p>}
          </Section>
        </div>
      </div>
    </div>
  )
}
