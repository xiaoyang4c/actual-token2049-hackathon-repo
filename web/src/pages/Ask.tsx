import {useEffect, useRef, useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {motion} from 'motion/react'
import {ArrowUp, Loader2, RotateCcw, Sparkles, Wand2} from 'lucide-react'
import {PageHeader, Tag} from '@/components/kit'
import {Reveal} from '@/components/motion'
import {Textarea} from '@/components/ui/textarea'
import {api, type AskJob, type AskTicket, type ChatEntry, type CoworkerSlug} from '@/lib/api'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const COWORKERS: Array<{slug: CoworkerSlug; name: string; does: string; avatar: string; example: string}> = [
  {slug: 'deal-desk', name: 'Deal Desk', does: 'Drafts an escrow contract', avatar: '/brand/deal-desk-avatar.png',
    example: 'We are buying 1,200 kg of Grade A green arabica from a farm in Sumatra for 4,000 USDM. A lab checks the quality. If the coffee is off-spec, the seller keeps 70%.'},
  {slug: 'mediator', name: 'Mediator', does: 'Drafts a ruling for a dispute', avatar: '/brand/mediator-avatar.png',
    example: 'contract: <contract id>\nmilestone: 0'},
  {slug: 'trust-check', name: 'Trust Check', does: "Explains a company's credit record", avatar: '/brand/trust-check-avatar.png',
    example: 'What is the record of Highland Estates Coffee?'},
]

const coworkerOf = (slug: CoworkerSlug | undefined) => COWORKERS.find((c) => c.slug === slug) ?? COWORKERS[0]

const MODE: Record<string, {label: string; tone: 'blue' | 'up' | 'warn'}> = {
  model: {label: 'AI answer', tone: 'blue'},
  'fill-in': {label: 'Answered without AI', tone: 'up'},
  'needs-input': {label: 'Needs more detail', tone: 'warn'},
}

type Target = CoworkerSlug | 'auto'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  coworker?: CoworkerSlug
  routed?: boolean
  mode?: AskJob['mode']
  status?: AskJob['status']
  position?: number
  error?: string | null
}

const STORE_KEY = 'tally-coworker-chat'
/** The server reads at most 12 earlier messages. */
const HISTORY = 12

/** Finished messages survive a page change in this tab. Storage can be missing; the chat still works. */
function loadChat(): Message[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]') as Message[]
    return Array.isArray(saved) ? saved.filter((m) => m.role === 'user' || m.status === 'done') : []
  } catch {
    return []
  }
}

function saveChat(messages: Message[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.filter((m) => m.role === 'user' || m.status === 'done')))
  } catch { /* storage unavailable */ }
}

/** Earlier messages for the server: what the user wrote and the finished answers. */
const historyOf = (messages: Message[]): ChatEntry[] => messages
  .filter((m) => m.role === 'user' || (m.status === 'done' && m.text))
  .map((m) => ({role: m.role, text: m.text, ...(m.coworker ? {coworker: m.coworker} : {})}))
  .slice(-HISTORY)

/** The answer is untrusted model text: no raw HTML, and links and images stay plain text. */
function Answer({text}: {text: string}) {
  return (
    <div className="answer text-[14px] leading-relaxed text-ink-2 [&_code]:mono [&_code]:rounded-[4px] [&_code]:bg-black/[0.05] [&_code]:px-1 [&_code]:text-[12.5px] [&_h1]:display [&_h1]:mb-3 [&_h1]:text-[20px] [&_h1]:text-ink [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:font-[family-name:var(--font-display)] [&_h2]:text-[15px] [&_h2]:text-ink [&_h3]:mt-4 [&_h3]:font-semibold [&_h3]:text-ink [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2.5 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-black/[0.04] [&_pre]:p-3 [&_strong]:text-ink [&_table]:my-3 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-[13px] [&_td]:border-t [&_td]:border-border [&_td]:py-1.5 [&_td]:pr-3 [&_th]:py-1.5 [&_th]:pr-3 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['a', 'img']} unwrapDisallowed>{text}</ReactMarkdown>
    </div>
  )
}

function Bubble({message}: {message: Message}) {
  if (message.role === 'user') {
    return (
      <motion.div initial={{opacity: 0, y: 6}} animate={{opacity: 1, y: 0}} className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-ink px-4 py-2.5 text-[14px] leading-relaxed text-white">{message.text}</p>
      </motion.div>
    )
  }
  // Until the server picks a Coworker for an auto message, Tally speaks.
  const who = message.coworker ? coworkerOf(message.coworker) : {name: 'Tally', avatar: '/brand/tally-mark.svg'}
  const working = message.status === 'queued' || message.status === 'running'
  return (
    <motion.div initial={{opacity: 0, y: 6}} animate={{opacity: 1, y: 0}} className="flex gap-3">
      <img src={who.avatar} alt="" className="mt-0.5 size-8 shrink-0 rounded-[8px] bg-white object-contain" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-[family-name:var(--font-display)] text-[13.5px]">{who.name}</span>
          {message.routed ? <span className="text-[11.5px] text-ink-3">picked for you</span> : null}
          {message.mode ? <Tag tone={MODE[message.mode].tone} className="ml-auto">{MODE[message.mode].label}</Tag> : null}
        </div>
        {working ? (
          <p className="mt-2 flex items-center gap-2 text-[13.5px] text-ink-3" role="status">
            <Loader2 className="size-4 animate-spin" />Working{message.position ? ` (${message.position} ahead of you)` : ''}…
          </p>
        ) : message.status === 'failed' ? (
          <p className="mt-2 rounded-[10px] bg-down-wash px-3.5 py-2.5 text-[13.5px] text-down">{message.error ?? 'The Coworker could not answer.'}</p>
        ) : (
          <div className="mt-1 rounded-[14px] rounded-tl-[4px] border border-border bg-white px-4 py-1"><Answer text={message.text} /></div>
        )}
      </div>
    </motion.div>
  )
}

export function AskPage() {
  const [params] = useSearchParams()
  const pinned = COWORKERS.find((c) => c.slug === params.get('coworker'))?.slug
  const [target, setTarget] = useState<Target>(pinned ?? 'auto')
  const [messages, setMessages] = useState<Message[]>(loadChat)
  const [text, setText] = useState(() => params.get('prompt')?.slice(0, 4000) ?? '')
  const busy = messages.some((m) => m.status === 'queued' || m.status === 'running')
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const list = useRef<HTMLDivElement>(null)
  const disputes = useAsync(() => api.contracts({disputes: true}), 'disputes')

  useEffect(() => {
    const pending = timers.current
    return () => { for (const timer of pending) clearTimeout(timer) }
  }, [])
  useEffect(() => { saveChat(messages) }, [messages])
  // The messages scroll inside the panel, so the message box stays in view.
  useEffect(() => { list.current?.scrollTo({top: list.current.scrollHeight, behavior: 'smooth'}) }, [messages.length, busy])

  // The Mediator's example names a real dispute from the contract list.
  const example = (slug: CoworkerSlug) => {
    if (slug !== 'mediator') return coworkerOf(slug).example
    const tier3 = disputes.data?.find((c) => c.milestones[0]?.state === 'tier_3_mediation') ?? disputes.data?.[0]
    return tier3 ? `contract: ${tier3.id}\nmilestone: 0` : COWORKERS[1].example
  }

  const update = (id: string, patch: Partial<Message>) =>
    setMessages((all) => all.map((m) => (m.id === id ? {...m, ...patch} : m)))

  const fromJob = (job: AskJob): Partial<Message> => ({
    coworker: job.coworker, routed: job.routed, status: job.status, position: job.position, mode: job.mode,
    text: job.answer ?? '', error: job.error,
  })

  const poll = (id: string, ticket: AskTicket) => {
    const timer = setTimeout(async () => {
      timers.current.delete(timer)
      try {
        const {job} = await api.askStatus(ticket)
        update(id, fromJob(job))
        if (job.status === 'queued' || job.status === 'running') poll(id, ticket)
      } catch (e) {
        update(id, {status: 'failed', error: e instanceof Error ? e.message : String(e)})
      }
    }, 1200)
    timers.current.add(timer)
  }

  const send = async (request = text) => {
    const clean = request.trim()
    if (!clean || busy) return
    const history = historyOf(messages)
    const stamp = `${Date.now()}`
    const reply: Message = {id: `a-${stamp}`, role: 'assistant', text: '', coworker: target === 'auto' ? undefined : target, status: 'queued'}
    setMessages((all) => [...all, {id: `u-${stamp}`, role: 'user', text: clean}, reply])
    setText('')
    try {
      const {job} = await api.ask(target, clean, history)
      update(reply.id, fromJob(job))
      if (job.status === 'queued' || job.status === 'running') poll(reply.id, job)
    } catch (e) {
      update(reply.id, {status: 'failed', error: e instanceof Error ? e.message : String(e)})
    }
  }

  const restart = () => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current.clear()
    setMessages([])
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Coworkers"
        title="Chat with Tally"
        description="Deal Desk drafts an escrow contract, Mediator drafts a ruling for a dispute, and Trust Check explains a company's credit record. Write in plain English here. The chat picks the right Coworker, and every number comes from Tally's code. The chat is free. Nothing is paid, signed or saved."
        actions={messages.length ? (
          <button type="button" onClick={restart} className="inline-flex h-10 items-center gap-2 rounded-[9px] border border-border bg-white px-3.5 text-[13px] font-medium text-ink-2 hover:text-ink">
            <RotateCcw className="size-4" />New chat
          </button>
        ) : null}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Reveal>
          <section className="surface flex h-[min(78dvh,860px)] min-h-[520px] flex-col rounded-[14px]" aria-label="Chat">
            <div ref={list} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6" aria-live="polite">
              {!messages.length ? (
                <div className="grid min-h-[340px] place-items-center text-center">
                  <div>
                    <Sparkles className="mx-auto size-6 text-ink-3" />
                    <p className="mt-3 text-[15px] font-medium">What can the Coworkers do for you?</p>
                    <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] text-ink-3">Describe a deal, name a disputed contract, or ask about a company. A follow-up keeps the same Coworker unless you ask for another one.</p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      {COWORKERS.map((c) => (
                        <button key={c.slug} type="button" onClick={() => setText(example(c.slug))} className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1.5 text-[12.5px] text-ink-2 hover:text-ink">
                          <img src={c.avatar} alt="" className="size-4 rounded-[4px]" />{c.does}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : messages.map((m) => <Bubble key={m.id} message={m} />)}
            </div>

            <div className="border-t border-border p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Who answers">
                <span className="mr-1 text-[12px] text-ink-3">Answered by</span>
                {([{slug: 'auto', name: 'Auto'}, ...COWORKERS] as Array<{slug: Target; name: string}>).map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    role="radio"
                    aria-checked={target === c.slug}
                    onClick={() => setTarget(c.slug)}
                    className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors',
                      target === c.slug ? 'border-ink bg-ink text-white' : 'border-border bg-white text-ink-2 hover:text-ink')}
                  >
                    {c.slug === 'auto' ? <Wand2 className="size-3.5" /> : null}{c.name}
                  </button>
                ))}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void send() }} className="flex items-end gap-2">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
                  }}
                  maxLength={4000}
                  rows={2}
                  placeholder={target === 'auto' ? 'Describe your deal, dispute, or the company you want to check…' : example(target)}
                  className="max-h-48 min-h-[52px] flex-1 resize-none bg-white text-[14px]"
                  aria-label="Message"
                />
                <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="grid size-[52px] shrink-0 place-items-center rounded-[10px] bg-ink text-white transition-colors hover:bg-ink-2 disabled:opacity-40">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </button>
              </form>
              <p className="mt-2 flex justify-between gap-3 text-[11.5px] text-ink-3">
                <span>Enter sends. Shift + Enter adds a line.</span>
                <span className="mono">{text.length}/4000</span>
              </p>
            </div>
          </section>
        </Reveal>

        <Reveal delay={0.08}>
          <aside className="space-y-3" aria-label="The Coworkers">
            {COWORKERS.map((c) => (
              <div key={c.slug} className="surface rounded-[14px] p-4">
                <div className="flex items-center gap-3">
                  <img src={c.avatar} alt="" className="size-9 rounded-[8px]" />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{c.name}</span>
                    <span className="block text-[12px] text-ink-3">{c.does}</span>
                  </span>
                </div>
                <button type="button" onClick={() => { setTarget('auto'); setText(example(c.slug)) }} className="mt-3 w-full rounded-[9px] bg-black/[0.035] px-3 py-2 text-left text-[12.5px] text-ink-2 hover:bg-black/[0.06] hover:text-ink">
                  <span className="line-clamp-2 whitespace-pre-line">{example(c.slug)}</span>
                </button>
              </div>
            ))}
            <p className="px-1 text-[12px] leading-relaxed text-ink-3">Plain English uses an AI model with a small daily allowance. When it runs out, the Coworker shows a fill-in format that always works.</p>
          </aside>
        </Reveal>
      </div>
    </div>
  )
}
