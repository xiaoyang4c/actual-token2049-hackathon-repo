import {APP_EDITION} from '@/lib/edition'
import {useMemo, useState} from 'react'
import {AlertTriangle, Check, FlaskConical, Plus, RotateCcw, Trash2} from 'lucide-react'
import {motion} from 'motion/react'
import Stepper, {Step} from '@/components/reactbits/Stepper'
import {Reveal} from '@/components/motion'
import {Amount, ErrorNote, KV, PageHeader, Section, Tag} from '@/components/kit'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {Skeleton} from '@/components/ui/skeleton'
import {api, type DraftInput, type DraftResult, type TemplateInfo} from '@/lib/api'
import {OUTCOME_LABEL, REMEDY_HELP, REMEDY_LABEL, dateTime, pretty} from '@/lib/format'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const FIELD_LABEL: Record<string, string> = {
  specDocumentSha256: 'Spec document SHA-256',
  expectedSha256: 'Expected file SHA-256',
  description: 'Description',
  quantity: 'Quantity',
  unit: 'Unit',
  grade: 'Grade',
  incoterm: 'Incoterm',
  fileName: 'File name',
  mediaType: 'Media type',
}
const NUMERIC = new Set(['quantity', 'revisionRounds'])
const HASH = /sha256$/i

interface MilestoneForm { title: string; amount: string; fields: Record<string, string> }

const remedyType = (value: string) => value.split(' ')[0]

function Field({label, children, hint}: {label: string; children: React.ReactNode; hint?: string}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] font-medium text-ink-2">{label}</Label>
      {children}
      {hint ? <p className="text-[11.5px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

export function DraftPreview({draft}: {draft: DraftResult}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <FlaskConical className="size-4 text-blue" />
        Drafted by the real contract engine in a sandbox. Nothing was stored and no transaction was sent.
        <Tag tone="quiet" className="ml-1">{draft.mode} mode</Tag>
      </div>
      {draft.placeholders.length ? (
        <div className="flex gap-3 rounded-[12px] bg-warn-wash px-4 py-3 text-[13.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>Replace before creating: {draft.placeholders.map((p) => `${FIELD_LABEL[p.field] ?? p.field}${p.milestoneIndex !== null ? ` (milestone ${p.milestoneIndex + 1})` : ''}`).join(', ')}.</p>
        </div>
      ) : null}

      {draft.milestones.map((m) => {
        const total = Number(BigInt(m.amount.atomic))
        return (
          <Reveal key={m.index}><Section title={`Milestone ${m.index + 1} · ${m.title}`} aside={<Amount display={m.amount.display} className="text-ink" />}>
            <p className="eyebrow mb-2.5">Escrows on Masumi</p>
            <div className="flex h-9 overflow-hidden rounded-[8px]">
              {m.escrows.map((e, i) => (
                <motion.div key={e.role} className={cn('flex items-center overflow-hidden px-3 text-[12.5px] font-medium', i === 0 ? 'bg-ink text-white' : 'bg-yellow text-ink')} initial={{width: 0}} animate={{width: `${(Number(BigInt(e.amount.atomic)) / total) * 100}%`}} transition={{duration: 0.9, delay: 0.2 + i * 0.15, ease: [0.22, 1, 0.36, 1]}}>
                  <span className="truncate capitalize">{e.role} · <span className="num">{e.amount.display.replace(' test USDM', '')}</span></span>
                </motion.div>
              ))}
            </div>
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div>
                <p className="eyebrow mb-2.5">If a dispute is decided</p>
                <KV rows={[
                  ['Seller wins', <span key="s">seller <Amount display={m.sellerWins.toSeller.display} /> · buyer <Amount display={m.sellerWins.toBuyer.display} /></span>],
                  ['Buyer wins', <span key="b">seller <Amount display={m.buyerWins.toSeller.display} /> · buyer <Amount display={m.buyerWins.toBuyer.display} /></span>],
                  ['Follow-up', pretty(m.buyerWinsFollowUp)],
                ]} className="grid-cols-[minmax(0,7rem)_minmax(0,1fr)]" />
              </div>
              <div>
                <p className="eyebrow mb-2.5">Tier 1 outcomes the parties can sign</p>
                <ul className="space-y-2 text-[13px]">
                  {m.tier1Options.map((o) => (
                    <li key={o.outcome} className="flex items-center justify-between gap-3 rounded-[8px] bg-black/[0.035] px-3 py-2">
                      <span className="font-medium">{OUTCOME_LABEL[o.outcome] ?? pretty(o.outcome)}</span>
                      <span className="num text-[12px] text-ink-2">{o.payout.toSeller.display.replace(' test USDM', '')} / {o.payout.toBuyer.display.replace(' test USDM', '')}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-ink-3">Seller / buyer, test USDM{APP_EDITION ? '. Two-sided outcome agreement is not built in the app yet.' : ''}</p>
              </div>
            </div>
          </Section></Reveal>
        )
      })}

      <Reveal className="grid gap-6 lg:grid-cols-2">
        <Section title="First milestone timeline" aside={`Max lock ${draft.maxLock.perMilestone.display}`}>
          <ol className="relative space-y-4 border-l border-black/10 pl-5">
            {Object.entries(draft.firstMilestoneTimeline).map(([key, m]) => (
              <li key={key} className="relative">
                <span className="absolute -left-[25px] top-1.5 size-2 rounded-[2px] bg-ink" />
                <p className="text-[13.5px] font-medium">{pretty(key.replace(/([A-Z])/g, ' $1').toLowerCase())}</p>
                <p className="text-[12.5px] text-ink-3">{dateTime(m.ms)}</p>
              </li>
            ))}
          </ol>
        </Section>
        <div className="space-y-6">
          <Section title="Disputes">
            <KV rows={[
              ['Tiers', draft.disputes.tiers.map((t) => `Tier ${t}`).join(' → ')],
              ...Object.entries(draft.disputes.tierWindows).map(([k, v]) => [pretty(k.replace('tier', 'Tier ')), v.display] as [string, string]),
              ['No ruling in time', `${pretty(draft.disputes.tier3TimeoutWinner)} wins`],
              ['Fits the dispute window', draft.disputes.budgetFits ? 'Yes' : 'No'],
            ]} />
          </Section>
          <Section title="Fees" aside={pretty(draft.fees.rule)}>
            <KV rows={[
              ...Object.entries(draft.fees.perTier).map(([k, v]) => [pretty(k.replace('tier', 'Tier ')), <Amount key={k} display={v.display} />] as [string, React.ReactNode]),
            ]} />
            <p className="mt-3 text-[12px] text-ink-3">{draft.fees.note}</p>
          </Section>
          <Section title="Live deadline check">
            {draft.liveDeadlineCheck.ok
              ? <p className="flex items-center gap-2 text-[13.5px] text-up"><Check className="size-4" />Deadlines meet the Masumi spacing rules.</p>
              : <ul className="list-disc space-y-1 pl-5 text-[13px] text-down">{draft.liveDeadlineCheck.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </Section>
        </div>
      </Reveal>

      {!APP_EDITION ? <Reveal><Section title="Create request" aside="POST /reliability/contracts">
        <pre className="mono max-h-80 overflow-auto rounded-[10px] bg-black/[0.035] p-4 text-[12px] leading-relaxed">{JSON.stringify(draft.createRequest, null, 2)}</pre>
      </Section></Reveal> : null}
    </div>
  )
}

function Wizard({templates, onDraft, attempt}: {templates: TemplateInfo[]; onDraft: (input: DraftInput) => void; attempt: number}) {
  const [step, setStep] = useState(attempt > 0 ? 4 : 1)
  const enabled = templates.filter((t) => t.status === 'enabled')
  const [templateId, setTemplateId] = useState(enabled.find((t) => t.id === 'physical-objective-spec')?.id ?? enabled[0]?.id ?? '')
  const template = templates.find((t) => t.id === templateId)
  const fields = useMemo(() => template ? [...template.deliverableFields.required, ...template.deliverableFields.optional] : [], [template])
  const [milestones, setMilestones] = useState<MilestoneForm[]>([{title: '1,200 kg green arabica, Grade A', amount: '4000', fields: {description: 'Green arabica, washed', quantity: '1200', unit: 'kg', grade: 'A', incoterm: 'FOB Belawan'}}])
  const [remedy, setRemedy] = useState('partial_release')
  const [share, setShare] = useState('70')
  const [inspector, setInspector] = useState('inspector-named-judge')
  const usesInspector = !!template && /inspector/i.test(template.judge)
  const allowed = template?.remedies.allowed ?? []

  const pickTemplate = (id: string) => {
    setTemplateId(id)
    const t = templates.find((x) => x.id === id)
    if (t) setRemedy(remedyType(t.remedies.default))
  }
  const update = (i: number, patch: Partial<MilestoneForm>) => setMilestones((ms) => ms.map((m, j) => (j === i ? {...m, ...patch} : m)))

  const missing = milestones.some((m) => !m.title.trim() || !(Number(m.amount) > 0) || (template?.deliverableFields.required ?? []).some((f) => !HASH.test(f) && !m.fields[f]?.trim()))

  const submit = () => onDraft({
    templateId,
    milestones: milestones.map((m) => ({
      title: m.title.trim(),
      amount: m.amount.trim(),
      deliverable: Object.fromEntries(fields.filter((f) => m.fields[f]?.trim()).map((f) => [f, NUMERIC.has(f) ? Number(m.fields[f]) : m.fields[f].trim()])),
    })),
    remedy: {type: remedy, ...(remedy === 'partial_release' ? {sellerSharePercent: share} : {})},
    ...(usesInspector ? {inspectors: [inspector], judgeInspector: inspector} : {}),
  })

  return (
    <Stepper key={attempt} initialStep={attempt > 0 ? 4 : 1} onStepChange={setStep} onFinalStepCompleted={submit} nextButtonProps={{disabled: step === 2 && missing}} nextButtonText="Continue" completeButtonText="Draft with the engine" stepCircleContainerClassName="surface ring-spin rounded-[18px] px-6 pb-6">
      <Step>
        <h3 className="display text-[19px]">Choose a template</h3>
        <p className="mt-1 text-[13.5px] text-ink-3">The template fixes the evidence rules, the judge and the windows.</p>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {templates.map((t) => {
            const on = t.status === 'enabled'
            return (
              <button key={t.id} type="button" disabled={!on} onClick={() => pickTemplate(t.id)}
                className={cn('rounded-[12px] border p-4 text-left transition-colors', t.id === templateId ? 'border-ink bg-white shadow-[0_0_0_1px_var(--ink)]' : 'border-border bg-white/70 hover:bg-white', !on && 'cursor-not-allowed opacity-50')}>
                <div className="flex items-center justify-between gap-2">
                  <p className="mono text-[12.5px] font-medium">{t.id}</p>
                  {on ? <Tag tone="up">Enabled</Tag> : <Tag tone="quiet">Design only</Tag>}
                </div>
                <p className="mt-2 text-[13px] leading-snug text-ink-2">{t.description}</p>
                <p className="mt-2 text-[12px] text-ink-3">Judge: {t.judge}</p>
              </button>
            )
          })}
        </div>
      </Step>

      <Step>
        <h3 className="display text-[19px]">Milestones</h3>
        <p className="mt-1 text-[13.5px] text-ink-3">Each milestone is funded, delivered and judged on its own. Amounts are in test USDM.</p>
        <div className="mt-5 space-y-4">
          {milestones.map((m, i) => (
            <div key={i} className="rounded-[12px] border border-border bg-white p-4">
              <div className="mb-3 flex items-center justify-between"><p className="eyebrow">Milestone {i + 1}</p>
                {milestones.length > 1 ? <button type="button" aria-label="Remove milestone" onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))} className="rounded-[6px] p-1.5 text-ink-3 hover:bg-black/[0.05] hover:text-down"><Trash2 className="size-4" /></button> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field label="Title"><Input value={m.title} onChange={(e) => update(i, {title: e.target.value})} className="bg-white" /></Field>
                <Field label="Amount"><Input inputMode="decimal" value={m.amount} onChange={(e) => update(i, {amount: e.target.value})} className="num bg-white" /></Field>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {fields.map((f) => (
                  <Field key={f} label={`${FIELD_LABEL[f] ?? pretty(f)}${template?.deliverableFields.required.includes(f) ? '' : ' (optional)'}`} hint={HASH.test(f) ? 'Leave empty to draft with a placeholder.' : undefined}>
                    <Input value={m.fields[f] ?? ''} inputMode={NUMERIC.has(f) ? 'numeric' : undefined} onChange={(e) => update(i, {fields: {...m.fields, [f]: e.target.value}})} className={cn('bg-white', HASH.test(f) && 'mono text-[12px]')} />
                  </Field>
                ))}
              </div>
            </div>
          ))}
          {milestones.length < (template?.maxMilestones ?? 10) ? (
            <Button variant="outline" onClick={() => setMilestones((ms) => [...ms, {title: '', amount: '', fields: {}}])} className="h-9 rounded-[9px] bg-white"><Plus className="size-4" />Add a milestone</Button>
          ) : null}
          {missing ? <p className="text-[12.5px] text-warn">Fill in each title, amount and required field before drafting.</p> : null}
        </div>
      </Step>

      <Step>
        <h3 className="display text-[19px]">Remedy and judge</h3>
        <p className="mt-1 text-[13.5px] text-ink-3">Fixed before funding. A ruling later only names the winner.</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field label="If the buyer wins a dispute" hint={REMEDY_HELP[remedy]}>
            <Select items={allowed.map((r) => ({value: r, label: REMEDY_LABEL[r] ?? r}))} value={remedy} onValueChange={(v) => setRemedy(String(v))}>
              <SelectTrigger className="h-10 w-full bg-white"><SelectValue /></SelectTrigger>
              <SelectContent>{allowed.map((r) => <SelectItem key={r} value={r}>{REMEDY_LABEL[r] ?? r}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {remedy === 'partial_release' ? (
            <Field label="Seller keeps (core share, %)" hint="The rest is the holdback that returns to the buyer.">
              <Input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} className="num bg-white" />
            </Field>
          ) : null}
          {usesInspector ? (
            <Field label="Named inspector (Tier 2 judge)" hint="Both parties agree this inspector before funding.">
              <Input value={inspector} onChange={(e) => setInspector(e.target.value)} className="mono bg-white text-[13px]" />
            </Field>
          ) : null}
        </div>
      </Step>

      <Step>
        <h3 className="display text-[19px]">Review</h3>
        <KV className="mt-5" rows={[
          ['Template', <span key="t" className="mono text-[12.5px]">{templateId}</span>],
          ['Milestones', milestones.map((m) => `${m.title || 'Untitled'} · ${m.amount || '0'} test USDM`).join('; ')],
          ['Remedy', `${REMEDY_LABEL[remedy] ?? remedy}${remedy === 'partial_release' ? `, seller keeps ${share}%` : ''}`],
          ...(usesInspector ? [['Named inspector', inspector] as [string, string]] : []),
        ]} />
        <p className="mt-5 text-[12.5px] text-ink-3">The Deal Desk runs createContract in an in-memory sandbox, so the engine checks every rule. Nothing is stored.</p>
      </Step>
    </Stepper>
  )
}

export function DealDeskPage() {
  const templates = useAsync(api.templates, 'templates')
  const [draft, setDraft] = useState<DraftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [round, setRound] = useState(0)
  const [attempt, setAttempt] = useState(0)

  const run = async (input: DraftInput) => {
    setBusy(true); setError(null); setDraft(null)
    try { setDraft(await api.draft(input)) } catch (e) { setError(e instanceof Error ? e.message : String(e)); setAttempt((a) => a + 1) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Deal Desk"
        title="Draft a contract"
        description="Describe the deal. The engine returns the escrows, what each side gets in every outcome, the deadlines and the fees, the same numbers the Deal Desk Coworker gives in the chat."
        actions={draft ? <Button variant="outline" onClick={() => { setDraft(null); setError(null); setAttempt(0); setRound((r) => r + 1) }} className="h-10 rounded-[9px] bg-white"><RotateCcw className="size-4" />New draft</Button> : undefined}
      />
      {templates.error ? <ErrorNote>{templates.error}</ErrorNote> : null}
      {error ? <ErrorNote>The engine rejected the draft: {error}</ErrorNote> : null}
      {templates.data && !draft ? <div className={busy ? 'hidden' : undefined}><Wizard key={round} templates={templates.data} onDraft={run} attempt={attempt} /></div> : null}
      {busy || (templates.loading && !templates.data) ? <Skeleton className="h-80 rounded-[16px] bg-white/70" /> : null}
      {draft ? <DraftPreview draft={draft} /> : null}
    </div>
  )
}
