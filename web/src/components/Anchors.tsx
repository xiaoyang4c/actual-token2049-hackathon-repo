import {AlertTriangle, ExternalLink, Link2, ShieldCheck, ShieldX} from 'lucide-react'
import {motion} from 'motion/react'
import {Hash, Tag} from '@/components/kit'
import type {AnchorView, CompanyAnchors, ContractAnchors} from '@/lib/api'
import {dateTime} from '@/lib/format'
import {cn} from '@/lib/utils'

const EXPLORER = 'https://preprod.cardanoscan.io/transaction/'

/** Only a preprod Cardanoscan URL with a 64-hex transaction id becomes a link. */
function TxLinks({urls}: {urls: string[]}) {
  const safe = urls.filter((url) => url.startsWith(EXPLORER) && /^[0-9a-f]{64}$/.test(url.slice(EXPLORER.length)))
  return (
    <>
      {safe.map((url) => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-blue hover:underline">
          View on Cardanoscan<ExternalLink className="size-3.5" />
        </a>
      ))}
    </>
  )
}

const STATUS: Record<AnchorView['status'], {label: string; tone: 'up' | 'warn' | 'quiet'}> = {
  confirmed: {label: 'On Cardano', tone: 'up'},
  sending: {label: 'Confirming', tone: 'warn'},
  waiting: {label: 'Next batch', tone: 'quiet'},
}

export function AnchorStatus({anchor}: {anchor: AnchorView}) {
  return (
    <div className="space-y-1.5 text-[13px]">
      <Tag tone={STATUS[anchor.status].tone}>{STATUS[anchor.status].label}</Tag>
      <p className="text-ink-2">
        {anchor.status === 'confirmed'
          ? <>Block <span className="num">{anchor.blockHeight}</span>{anchor.anchoredAt ? ` · ${dateTime(anchor.anchoredAt)}` : ''}</>
          : anchor.status === 'sending' ? 'Sent to Cardano, waiting for confirmations.' : 'Recorded. It goes on Cardano with the next anchor batch.'}
      </p>
      {anchor.status === 'confirmed' ? <TxLinks urls={anchor.explorerUrls} /> : null}
    </div>
  )
}

/** The settlement fingerprints of one contract. */
export function ContractAnchorList({anchors, names}: {anchors: ContractAnchors; names: (id: string) => string}) {
  if (!anchors.records.length) return <p className="text-[13.5px] text-ink-3">The fingerprint is recorded when the milestone settles.</p>
  return (
    <div className="space-y-5">
      {anchors.records.map((record) => (
        <div key={record.publicationId} className="space-y-3">
          {!record.recordUnchanged ? <p className="flex items-center gap-2 rounded-[8px] bg-down-wash px-3 py-2 text-[13px] text-down"><AlertTriangle className="size-4" />This record changed after it was fingerprinted.</p> : null}
          <AnchorStatus anchor={record.anchor} />
          <div className="flex items-center gap-2 text-[12px] text-ink-3"><span className="eyebrow">record</span><Hash value={record.recordHash} n={8} /></div>
          <ul className="space-y-1 text-[12.5px] text-ink-2">
            {record.entries.map((entry) => <li key={entry.entityId}>{names(entry.entityId)} · entry <span className="num">#{entry.seq}</span> in its chain</li>)}
          </ul>
        </div>
      ))}
      <p className="text-[11.5px] leading-snug text-ink-3">Only fingerprints go on the chain: no names, amounts or terms.</p>
    </div>
  )
}

/** A company's chain of settled records, drawn as linked blocks. */
export function CompanyChain({anchors}: {anchors: CompanyAnchors}) {
  const {chain, entries} = anchors
  if (!chain.length) return <p className="text-[13.5px] text-ink-3">No settled deals yet. Each settled deal adds a fingerprint to this chain.</p>
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13.5px]">
        <span className={cn('inline-flex items-center gap-1.5 font-semibold', chain.intact ? 'text-up' : 'text-down')}>
          {chain.intact ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" />}{chain.intact ? 'Chain intact' : 'Chain broken'}
        </span>
        <span className="text-ink-2"><span className="num">{chain.length}</span> {chain.length === 1 ? 'record' : 'records'} fingerprinted · <span className="num">{chain.anchored}</span> on Cardano</span>
      </div>
      {!chain.intact ? <ul className="space-y-1">{chain.problems.map((p) => <li key={p} className="text-[13px] text-down">{p}</li>)}</ul> : null}
      <ol className="flex flex-wrap items-center gap-y-3">
        {entries.map((entry, i) => (
          <motion.li key={entry.seq} className="flex items-center" initial={{opacity: 0, scale: 0.85}} whileInView={{opacity: 1, scale: 1}} viewport={{once: true}} transition={{delay: i * 0.06, duration: 0.35}}>
            {i > 0 ? <Link2 className="mx-1 size-4 text-ink-3" aria-hidden /> : null}
            <div className={cn('rounded-[10px] border px-3 py-2', entry.anchor.status === 'confirmed' ? 'border-ink bg-ink text-white' : 'border-ink/15 bg-white/80')}>
              <p className="mono text-[11px] opacity-70">#{entry.seq}</p>
              <p className="mono text-[11.5px]">{entry.entryHash.slice(0, 8)}</p>
              <p className="text-[10.5px] opacity-70">{STATUS[entry.anchor.status].label}</p>
            </div>
          </motion.li>
        ))}
      </ol>
      {chain.head ? <div className="flex items-center gap-2 text-[12px] text-ink-3"><span className="eyebrow">head</span><Hash value={chain.head} n={8} /></div> : null}
      <p className="text-[11.5px] leading-snug text-ink-3">Each entry links to the one before it, so an edited or deleted deal breaks the chain. Only fingerprints are public.</p>
    </div>
  )
}
