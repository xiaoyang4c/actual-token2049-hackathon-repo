import {useEffect, useRef, useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {motion} from 'motion/react'
import {Loader2, Send, Sparkles} from 'lucide-react'
import {ErrorNote, PageHeader, Section, Tag} from '@/components/kit'
import {Reveal} from '@/components/motion'
import {Textarea} from '@/components/ui/textarea'
import {api, type AskJob, type CoworkerSlug} from '@/lib/api'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const COWORKERS: Array<{slug: CoworkerSlug; name: string; does: string; avatar: string; example: string}> = [
  {slug: 'deal-desk', name: 'Deal Desk', does: 'Drafts an escrow contract', avatar: '/brand/deal-desk-avatar.png',
    example: 'We are buying 1,200 kg of Grade A green arabica from a farm in Sumatra for 4,000 USDM. A lab checks the quality. If the coffee is off-spec, the seller keeps 70%.'},
  {slug: 'mediator', name: 'Mediator', does: 'Drafts a ruling for a dispute', avatar: '/brand/mediator-avatar.png',
    example: 'contract: <contract id>\nmilestone: 0'},
  {slug: 'trust-check', name: 'Trust Check', does: "Explains a company's record", avatar: '/brand/trust-check-avatar.png',
    example: 'What is the record of Highland Estates Coffee?'},
]

const MODE: Record<string, {label: string; tone: 'blue' | 'up' | 'warn'}> = {
  model: {label: 'AI answer', tone: 'blue'},
  'fill-in': {label: 'Answered without AI', tone: 'up'},
  'needs-input': {label: 'Needs more detail', tone: 'warn'},
}

/** The answer is untrusted model text: no raw HTML, and links and images stay plain text. */
function Answer({text}: {text: string}) {
  return (
    <div className="answer text-[14px] leading-relaxed text-ink-2 [&_code]:mono [&_code]:rounded-[4px] [&_code]:bg-black/[0.05] [&_code]:px-1 [&_code]:text-[12.5px] [&_h1]:display [&_h1]:mb-3 [&_h1]:text-[20px] [&_h1]:text-ink [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:font-[family-name:var(--font-display)] [&_h2]:text-[15px] [&_h2]:text-ink [&_h3]:mt-4 [&_h3]:font-semibold [&_h3]:text-ink [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2.5 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-black/[0.04] [&_pre]:p-3 [&_strong]:text-ink [&_table]:my-3 [&_table]:w-full [&_table]:text-[13px] [&_td]:border-t [&_td]:border-border [&_td]:py-1.5 [&_td]:pr-3 [&_th]:py-1.5 [&_th]:pr-3 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['a', 'img']} unwrapDisallowed>{text}</ReactMarkdown>
    </div>
  )
}

export function AskPage() {
  const [params] = useSearchParams()
  const initial = (COWORKERS.find((c) => c.slug === params.get('coworker'))?.slug ?? 'deal-desk') as CoworkerSlug
  const [coworker, setCoworker] = useState<CoworkerSlug>(initial)
  const [text, setText] = useState('')
  const [job, setJob] = useState<AskJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disputes = useAsync(() => api.contracts({disputes: true}), 'disputes')
  const chosen = COWORKERS.find((c) => c.slug === coworker)!

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // The Mediator's example names a real dispute from the contract list.
  const example = (slug: CoworkerSlug) => {
    if (slug !== 'mediator') return COWORKERS.find((c) => c.slug === slug)!.example
    const tier3 = disputes.data?.find((c) => c.milestones[0]?.state === 'tier_3_mediation') ?? disputes.data?.[0]
    return tier3 ? `contract: ${tier3.id}\nmilestone: 0` : COWORKERS[1].example
  }

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const {job: next} = await api.askStatus(id)
        setJob(next)
        if (next.status === 'queued' || next.status === 'running') poll(id)
        else setBusy(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      }
    }, 1200)
  }

  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true); setError(null); setJob(null)
    try {
      const {job: started} = await api.ask(coworker, text.trim())
      setJob(started)
      if (started.status === 'done' || started.status === 'failed') setBusy(false)
      else poll(started.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Ask a Coworker"
        title="Ask a Coworker"
        description="A free preview of Deal Desk, Mediator and Trust Check. Nothing is paid and nothing is saved. Plain English uses an AI model with a small daily allowance; the fill-in format always works. For a paid Task with escrow, hire the Coworker on Sokosumi."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Reveal>
          <Section title="Your request">
            <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-1 2xl:grid-cols-3" role="radiogroup" aria-label="Coworker">
              {COWORKERS.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  role="radio"
                  aria-checked={c.slug === coworker}
                  onClick={() => setCoworker(c.slug)}
                  className={cn('flex items-center gap-3 rounded-[12px] border p-3 text-left transition-colors', c.slug === coworker ? 'border-ink bg-white shadow-[0_0_0_1px_var(--ink)]' : 'border-border bg-white/60 hover:bg-white')}
                >
                  <img src={c.avatar} alt="" className="size-9 rounded-[8px]" />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{c.name}</span>
                    <span className="block truncate text-[11.5px] text-ink-3">{c.does}</span>
                  </span>
                </button>
              ))}
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
              placeholder={example(coworker)}
              className="mt-5 min-h-40 bg-white text-[14px]"
              aria-label="Your request"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={submit} disabled={busy || !text.trim()} className="inline-flex h-10 items-center gap-2 rounded-[9px] bg-ink px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-ink-2 disabled:opacity-40">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}Ask {chosen.name}
              </button>
              <button type="button" onClick={() => setText(example(coworker))} className="h-10 rounded-[9px] px-3 text-[13px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink">Use an example</button>
              <span className="mono ml-auto text-[11px] text-ink-3">{text.length}/4000</span>
            </div>
            {error ? <div className="mt-4"><ErrorNote>{error}</ErrorNote></div> : null}
          </Section>
        </Reveal>

        <Reveal delay={0.08}>
          <section className="surface min-h-[320px] rounded-[14px]" aria-live="polite" aria-label="Answer">
            {!job ? (
              <div className="grid h-full min-h-[320px] place-items-center p-8 text-center">
                <div>
                  <Sparkles className="mx-auto size-6 text-ink-3" />
                  <p className="mt-3 text-[14.5px] font-medium">Your answer appears here</p>
                  <p className="mt-1.5 max-w-[42ch] text-[13px] text-ink-3">Pick a Coworker, write your request and press Ask. A fill-in request takes a second; plain English can take a minute.</p>
                </div>
              </div>
            ) : job.status === 'queued' || job.status === 'running' ? (
              <div className="grid min-h-[320px] place-items-center p-8">
                <p className="flex items-center gap-2 text-[14px] text-ink-2" role="status"><Loader2 className="size-4 animate-spin" />{COWORKERS.find((c) => c.slug === job.coworker)?.name} is working{job.position ? ` (${job.position} ahead of you)` : ''}…</p>
              </div>
            ) : job.status === 'failed' ? (
              <div className="p-6"><ErrorNote>{job.error ?? 'The Coworker could not answer.'}</ErrorNote></div>
            ) : (
              <motion.div initial={{opacity: 0, y: 10}} animate={{opacity: 1, y: 0}} className="p-6">
                <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-4">
                  <span className="flex items-center gap-2.5">
                    <img src={COWORKERS.find((c) => c.slug === job.coworker)?.avatar} alt="" className="size-7 rounded-[6px]" />
                    <span className="font-[family-name:var(--font-display)] text-[14px]">{COWORKERS.find((c) => c.slug === job.coworker)?.name}</span>
                  </span>
                  {job.mode ? <Tag tone={MODE[job.mode].tone}>{MODE[job.mode].label}</Tag> : null}
                </div>
                <Answer text={job.answer ?? ''} />
              </motion.div>
            )}
          </section>
        </Reveal>
      </div>
    </div>
  )
}
