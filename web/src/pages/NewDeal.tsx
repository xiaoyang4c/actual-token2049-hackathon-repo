import {useState} from 'react'
import {Link, useNavigate} from 'react-router-dom'
import {Plus, Search, Trash2} from 'lucide-react'
import {ErrorNote, PageHeader, Section, Tag} from '@/components/kit'
import {Reveal} from '@/components/motion'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {api, type DraftInput, type DraftResult, type EntityHit, type Role} from '@/lib/api'
import {toAtomic} from '@/lib/account'
import {useAppSession} from '@/lib/app-session'
import {deals, type CreateDeal} from '@/lib/deals'
import {REMEDY_LABEL, pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {DraftPreview} from './DealDesk'

interface MilestoneForm {title: string; amount: string; fields: Record<string, string>}
const blankMilestone = (): MilestoneForm => ({title: '', amount: '', fields: {}})
const FIELD_LABEL: Record<string, string> = {expectedSha256: 'Expected file SHA-256', fileName: 'File name', mediaType: 'Media type', quantity: 'Quantity', revisionRounds: 'Revision rounds'}
const SELECT = 'h-10 w-full rounded-[9px] border border-input bg-white px-3 text-[13.5px] outline-none focus-visible:border-ring'

export function NewDealPage() {
  const {session, me} = useAppSession()
  const navigate = useNavigate()
  const templates = useAsync(() => api.templates(), 'app-draft-templates')
  const available = (templates.data ?? []).filter((template) => template.status === 'enabled' && !/signed[_ ]report|monitoring/i.test(template.judge) && ![...template.deliveryEvidence, ...template.buyerDisputeEvidence].some((rule) => /signed by/i.test(rule)))
  const [templateId, setTemplateId] = useState('')
  const template = available.find((item) => item.id === templateId) ?? available[0]
  const [role, setRole] = useState<Role>('buyer')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<EntityHit[]>([])
  const [counterparty, setCounterparty] = useState<EntityHit | null>(null)
  const profile = useAsync(() => counterparty ? api.profile(counterparty.id) : Promise.resolve(null), `new-deal-counterparty-${counterparty?.id}`)
  const [milestones, setMilestones] = useState<MilestoneForm[]>([blankMilestone()])
  const [remedy, setRemedy] = useState('full_refund_no_return')
  const [share, setShare] = useState('70')
  const [preview, setPreview] = useState<{draft: DraftResult; request: CreateDeal} | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  if (!session || !me) return null
  if (!me.readiness.dealKey || !me.readiness.kyc) return <div className="space-y-8"><PageHeader title="Get ready for your first deal" description="Pass mock KYC and set up deal signing on Account. Paper deals need no deposit. Live deals use preprod test funds." /><Section title="Account setup"><Link to="/account" className="text-[14px] font-semibold underline">Finish account setup</Link></Section></div>

  const changeMilestone = (index: number, next: MilestoneForm) => {
    setMilestones((items) => items.map((item, current) => current === index ? next : item)); setPreview(null)
  }
  const findCounterparty = async () => {
    setSearching(true); setError(null)
    try { setHits((await api.search(query.trim())).filter((item) => item.id !== me.entityId)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSearching(false) }
  }
  const draft = async () => {
    if (!template || !counterparty) return
    setBusy(true); setError(null); setPreview(null)
    try {
      const input: DraftInput = {
        templateId: template.id,
        milestones: milestones.map((item) => ({
          title: item.title, amount: item.amount,
          deliverable: Object.fromEntries(Object.entries(item.fields).filter(([, value]) => value.trim()).map(([field, value]) => [field, ['quantity', 'revisionRounds'].includes(field) ? Number(value) : value.trim()])),
        })),
        remedy: {type: remedy, ...(remedy === 'partial_release' ? {sellerSharePercent: share} : {})},
      }
      if (milestones.some((item) => !toAtomic(item.amount, 6))) throw new Error('Each milestone needs a positive test USDM amount with at most six decimals.')
      const result = await api.draft(input)
      if (result.placeholders.length) throw new Error(`Fill in these deliverable fields: ${result.placeholders.map((item) => item.field).join(', ')}.`)
      const request: CreateDeal = {
        templateId: template.id, role, counterpartyId: counterparty.id,
        milestones: result.createRequest.milestones as CreateDeal['milestones'],
        remedy: result.createRequest.remedy as CreateDeal['remedy'],
      }
      setPreview({draft: result, request})
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const create = async () => {
    if (!preview) return
    setBusy(true); setError(null)
    try {
      const result = await deals.create(session, preview.request)
      navigate(`/deals/${result.contract.id}`)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="New deal" description="Agree on the deliverable, the evidence, and the remedy. Your counterparty signs the same terms. All amounts use preprod test USDM." />
      {templates.error ? <ErrorNote>{templates.error}</ErrorNote> : null}
      {templates.loading ? <p role="status" className="text-[14px] text-ink-3">Loading deal templates…</p> : templates.data && !available.length ? <ErrorNote>No app templates are available.</ErrorNote> : null}
      {template ? <form onSubmit={(event) => { event.preventDefault(); void draft() }} className="space-y-6">
        <Reveal><Section title="Deal parties and template">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="space-y-1.5 text-[13px] font-medium">Template
              <select className={SELECT} value={template.id} onChange={(event) => { const next = available.find((item) => item.id === event.target.value)!; setTemplateId(next.id); setRemedy(next.remedies.default.split(' ')[0]); setMilestones([blankMilestone()]); setPreview(null) }}>
                {available.map((item) => <option key={item.id} value={item.id}>{pretty(item.id)}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-[13px] font-medium">My role
              <select className={SELECT} value={role} onChange={(event) => { setRole(event.target.value as Role); setPreview(null) }}><option value="buyer">Buyer — I pay for the deliverable</option><option value="seller">Seller — I deliver the work</option></select>
            </label>
          </div>
          <p className="mt-4 max-w-[65ch] text-[13px] text-ink-2">{template.description}</p>
          <p className="mt-2 text-[12px] text-ink-3">Inspector templates are not available in the app yet.</p>
        </Section></Reveal>
        <Section title={`Find the ${role === 'buyer' ? 'seller' : 'buyer'}`}>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 space-y-1.5 text-[13px] font-medium">Company name or Tally id<Input className="h-10 bg-white" value={query} onChange={(event) => { setQuery(event.target.value); setHits([]) }} /></label>
            <Button type="button" disabled={searching || query.trim().length < 2} onClick={() => void findCounterparty()} className="h-10 self-start sm:self-end"><Search className="size-4" />{searching ? 'Searching…' : 'Search'}</Button>
          </div>
          <ul className="mt-4 space-y-2">{hits.map((hit) => <li key={hit.id}><button type="button" onClick={() => { setCounterparty(hit); setPreview(null) }} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-[9px] border border-border bg-white px-4 py-3 text-left text-[13.5px] hover:bg-yellow-wash">
            <span>{hit.displayName}<span className="mono mt-1 block break-all text-[11px] text-ink-3">{hit.id}</span></span><Tag tone={hit.kycStatus === 'verified' ? 'up' : 'warn'}>KYC {hit.kycStatus}</Tag>
          </button></li>)}</ul>
          {counterparty ? <div className="mt-5 border-t border-border pt-4 text-[13px] text-ink-2"><p className="font-semibold text-ink">Selected: {counterparty.displayName}</p><p className="mt-2">Mock KYC: {counterparty.kycStatus} · {counterparty.kycTier}</p>
            {profile.data ? <p className="mt-2">{profile.data.contractSummary.live.milestones} live milestones · {profile.data.contractSummary.simulated.milestones} paper milestones · {profile.data.contractSummary.live.disputesLost + profile.data.contractSummary.simulated.disputesLost} disputes lost</p> : null}
            {profile.error ? <ErrorNote>{profile.error}</ErrorNote> : null}<Link to={`/companies?id=${encodeURIComponent(counterparty.id)}`} className="mt-2 inline-block font-medium underline">View company record</Link>
          </div> : <p className="mt-3 text-[13px] text-ink-3">Choose a counterparty from the search results. They must pass KYC and set up deal signing.</p>}
        </Section>
        <Section title="Milestones" aside="Sequential funding · test USDM">
          <div className="space-y-6">{milestones.map((item, index) => <div key={index} className="space-y-4 border-b border-border pb-6 last:border-0 last:pb-0">
            <div className="flex items-center justify-between"><h3 className="text-[14px] font-semibold">Milestone {index + 1}</h3>{milestones.length > 1 ? <button type="button" aria-label={`Remove milestone ${index + 1}`} className="rounded-[6px] p-2 hover:bg-down-wash" onClick={() => { setMilestones((items) => items.filter((_, current) => current !== index)); setPreview(null) }}><Trash2 className="size-4" /></button> : null}</div>
            <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-[13px]">Title<Input required className="h-10 bg-white" value={item.title} onChange={(event) => changeMilestone(index, {...item, title: event.target.value})} /></label><label className="space-y-1.5 text-[13px]">Amount in test USDM<Input required inputMode="decimal" className="h-10 bg-white" value={item.amount} onChange={(event) => changeMilestone(index, {...item, amount: event.target.value})} /></label></div>
            <div className="grid gap-4 sm:grid-cols-2">{[...template.deliverableFields.required, ...template.deliverableFields.optional].map((field) => <label key={field} className="space-y-1.5 text-[13px]">{FIELD_LABEL[field] ?? pretty(field)}{template.deliverableFields.optional.includes(field) ? ' (optional)' : ''}
              <Input required={template.deliverableFields.required.includes(field)} pattern={/sha256$/i.test(field) ? '[0-9a-fA-F]{64}' : undefined} className="h-10 bg-white" value={item.fields[field] ?? ''} onChange={(event) => changeMilestone(index, {...item, fields: {...item.fields, [field]: event.target.value}})} />
            </label>)}</div>
          </div>)}</div>
          <Button type="button" variant="outline" className="mt-5" disabled={milestones.length >= template.maxMilestones} onClick={() => { setMilestones((items) => [...items, blankMilestone()]); setPreview(null) }}><Plus className="size-4" />Add milestone</Button>
        </Section>
        <Section title="Remedy if the buyer wins a dispute">
          <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-[13px]">Remedy<select className={SELECT} value={remedy} onChange={(event) => { setRemedy(event.target.value); setPreview(null) }}>{template.remedies.allowed.map((type) => <option key={type} value={type}>{REMEDY_LABEL[type] ?? pretty(type)}</option>)}</select></label>
            {remedy === 'partial_release' ? <label className="space-y-1.5 text-[13px]">Seller keeps (%)<Input required inputMode="decimal" className="h-10 bg-white" value={share} onChange={(event) => { setShare(event.target.value); setPreview(null) }} /></label> : null}
          </div>
        </Section>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button type="submit" className="min-h-10" disabled={busy || !counterparty || counterparty.kycStatus !== 'verified'}>{busy ? 'Working…' : 'Preview payouts, timeline, and fees'}</Button>
      </form> : null}
      {preview ? <div className="space-y-6"><DraftPreview draft={preview.draft} /><Section title="Create this deal">
        <p className="mb-4 text-[13.5px] text-ink-2">This creates a draft for you and {counterparty?.displayName}. Submit it for acceptance on the deal page. Each party must then sign the frozen terms.</p>
        <Button type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create deal'}</Button>
      </Section></div> : null}
    </div>
  )
}
