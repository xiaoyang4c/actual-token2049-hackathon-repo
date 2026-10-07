import {useEffect, useState} from 'react'
import {useParams} from 'react-router-dom'
import {DealSigning} from '@/components/DealSigning'
import {ErrorNote, Section, Tag} from '@/components/kit'
import {Input} from '@/components/ui/input'
import {useAppSession} from '@/lib/app-session'
import type {ContractSummary, ContractView, MilestoneSummary, Role} from '@/lib/api'
import type {Session} from '@/lib/account'
import {availableActions} from '@/lib/deal-actions'
import {deals, partyActionBytes, signTerms, type AppMe, type EvidenceInput, type PartyAction, type PartyActionType} from '@/lib/deals'
import {pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {ContractDetails} from './Contract'

interface EvidenceRule {type: string; min: number; max?: number; signedBy?: string}
interface EvidenceForm {text: string; files: File[]}

function ActionPanel({session, me, view, index, next, refresh}: {
  session: Session; me: AppMe; view: ContractView; index: number; next?: MilestoneSummary['next']; refresh: () => void
}) {
  const milestone = view.milestones[index]
  const role: Role = view.contract.buyerId === me.entityId ? 'buyer' : 'seller'
  const options = availableActions(view, index, role, next)
  const [selected, setSelected] = useState<PartyActionType | 'sign_terms' | ''>('')
  const action = options.some((item) => item.action === selected) ? selected : options[0]?.action
  const [evidence, setEvidence] = useState<Record<string, EvidenceForm>>({})
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const terms = useAsync(() => view.contract.termsSha256 ? deals.terms(session, view.contract.id) : Promise.resolve(null), `app-terms-${view.contract.id}-${view.contract.termsSha256}-${session.token}`)
  const delivery = view.contract.terms.delivery as {requiredEvidence: EvidenceRule[]}
  const dispute = view.contract.terms.dispute as {buyerEvidence: EvidenceRule[]}
  const rules = action === 'deliver' || action === 'redeliver' ? delivery.requiredEvidence
    : action === 'dispute' ? dispute.buyerEvidence
      : action === 'record_return_shipment' ? [{type: 'return_tracking', min: 1, max: 1}] : []
  const validEvidence = rules.every((rule) => {
    const item = evidence[rule.type]
    const count = (item?.text.trim() ? 1 : 0) + (item?.files.length ?? 0)
    return count >= rule.min && (rule.max === undefined || count <= rule.max)
  }) && (action !== 'dispute' || rules.some((rule) => evidence[rule.type]?.text.trim() || evidence[rule.type]?.files.length))
  const disabled = !validEvidence || (action === 'dispute' && !reason.trim()) || (action === 'sign_terms' && !terms.data)

  return <Section title="Your next action" aside={<Tag tone="quiet">{pretty(role)}</Tag>}>
    <p className="mb-4 text-[13.5px] text-ink-2">{next?.action ?? 'Waiting for the next step.'}{next?.actor === 'escrow' ? ' The escrow worker processes this step.' : ''}</p>
    {milestone.state === 'awaiting_funding' ? <p className="mb-4 text-[13px] text-ink-2">The escrow funds this milestone after both signatures and the previous milestone. Live funding uses the buyer’s confirmed preprod test deposits.</p> : null}
    {milestone.state === 'tier_1_negotiation' ? <p className="mb-4 text-[13px] text-ink-2">Two-sided outcome agreement is not built in the app yet. Either party can escalate.</p> : null}
    {milestone.state === 'tier_3_mediation' ? <p className="text-[13px] text-ink-2">The Mediation desk stays private. Wait for the ruling or the mediation deadline.</p> : null}
    {!me.party ? <p className="text-[13px] text-ink-2">Set up deal signing on Account before taking an action.</p> : options.length ? <div className="space-y-5">
      {options.length > 1 ? <label className="block space-y-1.5 text-[13px] font-medium">Action
        <select className="h-10 w-full rounded-[9px] border border-input bg-white px-3 outline-none focus-visible:border-ring" value={action} onChange={(event) => { setSelected(event.target.value as PartyActionType); setEvidence({}); setError(null) }}>{options.map((item) => <option key={item.action} value={item.action}>{item.label}</option>)}</select>
      </label> : null}
      {action === 'sign_terms' ? <div className="space-y-2 rounded-[9px] bg-black/[0.035] p-4">
        <p className="text-[13px] font-semibold">Terms SHA-256</p><p className="mono break-all text-[12px] text-ink-2">{terms.data?.termsSha256 ?? view.contract.termsSha256}</p>
        <p className="text-[12.5px] text-ink-2">Review the signed terms below. Your signature accepts these exact bytes.</p>
        {terms.data ? <details className="text-[12.5px]"><summary className="cursor-pointer font-medium">Read the full frozen terms</summary><pre className="mono mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11.5px]">{terms.data.termsBytes}</pre></details> : null}
        {terms.error ? <ErrorNote>{terms.error}</ErrorNote> : null}
      </div> : null}
      {rules.length ? <div className="space-y-4"><p className="text-[13px] text-ink-2">Send the evidence named in the terms as text or files. Each item must be at most 1 MiB. A file is sent as base64.</p>
        {rules.map((rule) => <div key={rule.type} className="space-y-2">
          <label className="block space-y-1.5 text-[13px] font-medium">{pretty(rule.type)} · {rule.min ? `${rule.min} required` : 'optional'}
            <textarea rows={3} className="w-full rounded-[9px] border border-input bg-white px-3 py-2 text-[13px] outline-none focus-visible:border-ring" value={evidence[rule.type]?.text ?? ''} onChange={(event) => setEvidence((items) => ({...items, [rule.type]: {text: event.target.value, files: items[rule.type]?.files ?? []}}))} />
          </label>
          <label className="block text-[12.5px] text-ink-2">Or attach {pretty(rule.type).toLowerCase()}
            <input type="file" multiple={rule.max !== 1} className="mt-2 block w-full text-[12px] file:mr-3 file:rounded-[6px] file:border file:border-border file:bg-white file:px-3 file:py-2" onChange={(event) => setEvidence((items) => ({...items, [rule.type]: {text: items[rule.type]?.text ?? '', files: Array.from(event.target.files ?? [])}}))} />
          </label>
          {rule.max ? <p className="text-[11.5px] text-ink-3">At most {rule.max} item{rule.max === 1 ? '' : 's'}. Text and each file count as separate items.</p> : null}
        </div>)}
      </div> : null}
      {action === 'dispute' || action === 'cancel' ? <label className="block space-y-1.5 text-[13px] font-medium">{action === 'dispute' ? 'Dispute reason (required)' : 'Cancellation reason (optional)'}<Input className="h-10 bg-white" value={reason} onChange={(event) => setReason(event.target.value)} /></label> : null}
      <p className="text-[12px] text-ink-3">Your wallet signs one message to derive your deal key. This message moves no funds. The signed deal action instructs the escrow.</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <DealSigning session={session} me={me} disabled={disabled} label={options.find((item) => item.action === action)?.label ?? 'Sign action'} work={async (key) => {
        setError(null)
        try {
          if (action === 'sign_terms') {
            if (!terms.data) return
            await deals.sign(session, view.contract.id, signTerms(key, terms.data))
          } else if (action) {
            const items: EvidenceInput[] = []
            for (const rule of rules) {
              const form = evidence[rule.type]
              if (form?.text.trim()) {
                if (new TextEncoder().encode(form.text).length > 1_048_576) throw new Error('Each evidence item must be at most 1 MiB.')
                items.push({type: rule.type, content: form.text, mediaType: 'text/plain'})
              }
              for (const file of form?.files ?? []) {
                if (file.size > 1_048_576) throw new Error('Each evidence file must be at most 1 MiB.')
                items.push({type: rule.type, content: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || 'application/octet-stream'})
              }
            }
            const request: PartyAction = {actionId: crypto.randomUUID(), contractId: view.contract.id, milestoneId: ['submit_for_acceptance', 'cancel'].includes(action) ? null : milestone.id, partyId: me.entityId, action, evidence: items, ...(reason.trim() ? {reason: reason.trim()} : {})}
            await deals.action(session, request, key.sign(partyActionBytes(request)))
          }
          refresh()
        } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
      }} />
    </div> : <p className="text-[13px] text-ink-3">No action is due from you now.</p>}
  </Section>
}

export function AppContractPage() {
  const {id = ''} = useParams()
  const {session, me} = useAppSession()
  const [index, setIndex] = useState(0)
  const [revision, setRevision] = useState(0)
  const key = `${id}-${session?.token}-${revision}`
  const view = useAsync(() => deals.contract(session!, id), `app-view-${key}`)
  const kase = useAsync(() => deals.disputeCase(session!, id, index), `app-case-${key}-${index}`)
  const audit = useAsync(() => deals.audit(session!, id), `app-audit-${key}`)
  const anchors = useAsync(() => deals.anchors(session!, id), `app-anchors-${key}`)
  const summaries = useAsync(() => deals.contracts(session!), `app-summary-${key}`)
  const summary: ContractSummary | undefined = summaries.data?.find((item) => item.id === id)
  useEffect(() => {
    if (!view.data?.milestones.some((item) => !['settled', 'refunded', 'cancelled', 'expired'].includes(item.state))) return
    const timer = setInterval(() => setRevision((value) => value + 1), 15_000)
    return () => clearInterval(timer)
  }, [view.data])
  if (!session || !me) return null
  if (view.error || kase.error) return <ErrorNote>{view.error ?? kase.error}</ErrorNote>
  if (!view.data || !kase.data || kase.data.milestone.index !== index) return <p role="status" className="text-[14px] text-ink-3">Loading your deal…</p>
  return <div className="space-y-6">
    {view.data.milestones.length > 1 ? <label className="block space-y-2 text-[13px] font-medium">Milestone<select value={index} onChange={(event) => setIndex(Number(event.target.value))} className="h-10 w-full rounded-[9px] border border-input bg-white px-3 outline-none focus-visible:border-ring">{view.data.contract.terms.milestones.map((item, current) => <option key={current} value={current}>{current + 1}. {item.title}</option>)}</select></label> : null}
    {audit.error ? <ErrorNote>{audit.error}</ErrorNote> : null}
    {summaries.error ? <ErrorNote>{summaries.error}</ErrorNote> : null}
    <ContractDetails view={view.data} kase={kase.data} audit={audit.data} anchors={anchors.data} anchorsError={anchors.error} summary={summary} milestoneIndex={index} privateDeal
      actions={<ActionPanel key={`${id}-${index}-${view.data.milestones[index].state}`} session={session} me={me} view={view.data} index={index} next={summary?.milestones[index]?.next} refresh={() => setRevision((value) => value + 1)} />} />
  </div>
}
