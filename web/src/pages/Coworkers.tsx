import {Link} from 'react-router-dom'
import {ArrowRight, Cpu, ShieldCheck} from 'lucide-react'
import ScrollReveal from '@/components/reactbits/ScrollReveal'
import SpotlightCard from '@/components/reactbits/SpotlightCard'
import {Reveal, Stagger, StaggerItem} from '@/components/motion'
import {Hash, PageHeader, Section} from '@/components/kit'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'

/* From services/reliability/coworkers/README.md in the copied repository. */
const COWORKERS = [
  {
    name: 'Tally Deal Desk', avatar: '/brand/deal-desk-avatar.png', to: '/ask?coworker=deal-desk', open: 'Ask the Deal Desk',
    job: 'Turns a plain-English deal into a ready-to-sign escrow contract draft.',
    detail: 'Runs createContract in an in-memory sandbox, so the engine validates every draft. Returns escrows, payouts per outcome, Tier 1 options, the timeline, the maximum lock time, fees and a live deadline check.',
    tools: ['listTemplates()', 'draftContract(input)'],
    sokosumi: '01a11354-0a28-745c-8424-c0f06b1331cb', spotlight: 'rgba(255, 212, 0, 0.22)' as const,
  },
  {
    name: 'Tally Mediator', avatar: '/brand/mediator-avatar.png', to: '/ask?coworker=mediator', open: 'Ask the Mediator',
    job: 'Drafts a Tier 3 ruling for a human mediator to sign.',
    detail: 'Reads the case file and simulates each ruling with the real engine on a copy. Returns the exact bytes the mediator signs. The Coworker never signs.',
    tools: ['disputeCase(contractId, milestone)', 'rulingOptions(contractId, milestone)', 'rulingSigningPayload(…)'],
    sokosumi: '01a11354-2a34-71af-917c-8114f24fc1cb', spotlight: 'rgba(0, 51, 173, 0.14)' as const,
  },
  {
    name: 'Tally Trust Check', avatar: '/brand/trust-check-avatar.png', to: '/ask?coworker=trust-check', open: 'Ask Trust Check',
    job: "Explains a company's Tally record before a deal.",
    detail: 'Reads scores through the scoring policy, stored terms decisions and contract history. Labels paper records SIMULATED and never gives a verdict.',
    tools: ['findEntities(query)', 'reliabilityProfile(entityId)'],
    sokosumi: '01a11354-467b-7049-826a-0e7087f78a59', spotlight: 'rgba(83, 252, 24, 0.16)' as const,
  },
]

const FLOW = [
  ['Read the task', "With the Coworker's own key, in personal or organization workspaces."],
  ['Answer without a model', 'Compute the whole answer first. An unreadable request gets INPUT_REQUIRED with a fill-in format, and nobody pays.'],
  ['Request payment', 'Ask the Masumi payment service for a payment request and post it to the task. Sokosumi locks the buyer’s test USDM.'],
  ['Wait for FundsLocked', 'Run the model only after the lock is confirmed in a transaction.'],
  ['Submit the result', 'Submit the result hash in the form Sokosumi checks, then complete the task.'],
  ['Collect', 'Follow the escrow until the payment service collects for the seller, and record the transaction.'],
]

export function CoworkersPage() {
  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Coworkers · Sokosumi"
        title="Three agents, one rule"
        description="Tally's contract features, sold as paid tasks on Sokosumi. The language model reads the request, calls Tally's tools and explains the results. Every number comes from Tally's code."
      />

      <Stagger className="grid gap-5 lg:grid-cols-3">
        {COWORKERS.map((c) => (
          <StaggerItem key={c.name} className="flex">
          <SpotlightCard spotlightColor={c.spotlight} className="surface flex w-full flex-col rounded-[18px] p-6 transition-transform duration-300 hover:-translate-y-1">
            <div className="flex items-center gap-4">
              <img src={c.avatar} alt="" className="size-14 rounded-[12px] shadow-[0_4px_14px_-6px_rgb(11_14_15/0.4)]" />
              <h2 className="display text-[17px]">{c.name}</h2>
            </div>
            <p className="mt-5 text-[15.5px] font-medium leading-snug">{c.job}</p>
            <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{c.detail}</p>
            <div className="mt-5">
              <p className="eyebrow mb-2">Tools</p>
              <ul className="space-y-1">{c.tools.map((t) => <li key={t} className="mono text-[12px] text-ink-2">{t}</li>)}</ul>
            </div>
            <div className="mt-auto pt-6">
              <Link to={c.to} className="inline-flex h-10 items-center gap-2 rounded-[9px] bg-ink px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-ink-2">
                {c.open}<ArrowRight className="size-4" />
              </Link>
            </div>
          </SpotlightCard>
          </StaggerItem>
        ))}
      </Stagger>

      <section className="py-10 sm:py-16">
        <p className="eyebrow mb-6 flex items-center gap-2"><span className="h-px w-6 bg-ink/40" aria-hidden />The rule</p>
        <ScrollReveal baseOpacity={0.08} enableBlur baseRotation={2} blurStrength={6} textClassName="display max-w-[22ch] text-[clamp(1.9rem,4.6vw,3.6rem)] leading-[1.12] text-ink">
          Every number comes from Tally's code. The model reads the request, calls the tools and explains the result. It never calculates.
        </ScrollReveal>
      </section>

      <Reveal className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Section title="How a task gets paid" aside="Masumi escrow on Cardano preprod">
          <ol className="space-y-5">
            {FLOW.map(([title, body], i) => (
              <li key={title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
                <span className={`num grid size-8 place-items-center rounded-[8px] text-[12.5px] font-semibold ${i === 3 ? 'bg-blue text-white' : 'bg-black/[0.06] text-ink'}`}>{i + 1}</span>
                <div>
                  <p className="text-[14.5px] font-semibold">{title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 rounded-[10px] bg-black/[0.035] px-4 py-3 text-[13px] text-ink-2">If the funds don’t lock before the result deadline, or the model fails, the task is marked failed and no result is submitted, so the escrow refunds the buyer.</p>
        </Section>

        <div className="space-y-6">
          <Section title="The rule">
            <div className="space-y-4 text-[13.5px] leading-relaxed text-ink-2">
              <p className="flex gap-3"><Cpu className="mt-0.5 size-4 shrink-0 text-ink" /><span><span className="font-semibold text-ink">Deterministic tools.</span> Amounts are exact <span className="mono">bigint</span> values. Simulations run the real engine on an in-memory copy and never write to the store.</span></p>
              <p className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink" /><span><span className="font-semibold text-ink">Model outage, not a numbers outage.</span> A structured task can be answered with no model at all. The model only turns free text into tool inputs and writes the explanation.</span></p>
            </div>
          </Section>
          <Section title="Registrations" bodyClassName="p-0">
            <Table>
              <TableHeader><TableRow><TableHead className="pl-5">Coworker</TableHead><TableHead className="pr-5">Sokosumi id</TableHead></TableRow></TableHeader>
              <TableBody>
                {COWORKERS.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="pl-5 font-medium">{c.name.replace('Tally ', '')}</TableCell>
                    <TableCell className="pr-5"><Hash value={c.sokosumi} n={6} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="flex flex-wrap items-center gap-1.5 border-t border-border px-5 py-3 text-[12px] text-ink-3">All three registered as Masumi agents on preprod in tx <Hash value="e72ca0405c431f9f02db1dbf5743557344f0e0a11dc65678580aafb4073b2352" n={6} /></p>
          </Section>
        </div>
      </Reveal>
    </div>
  )
}
