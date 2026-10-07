import {BadgeCheck, CircleAlert, FileText} from 'lucide-react'
import {Hash, Tag} from '@/components/kit'
import type {DisputeCase, Evidence} from '@/lib/api'
import {EVIDENCE_LABEL, dateTime, pretty} from '@/lib/format'

function quoted(e: Evidence): {verdict?: string; findings?: string; text: string} | null {
  if (!e.quotedContent) return null
  try {
    const parsed = JSON.parse(e.quotedContent.text) as {verdict?: string; findings?: string}
    return {verdict: parsed.verdict, findings: parsed.findings, text: e.quotedContent.text}
  } catch {
    return {text: e.quotedContent.text}
  }
}

export function EvidenceItem({item}: {item: Evidence}) {
  const q = quoted(item)
  return (
    <li className="rounded-[12px] border border-border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText className="size-4 shrink-0 text-ink-3" strokeWidth={1.8} />
          <p className="truncate text-[14px] font-semibold">{EVIDENCE_LABEL[item.type] ?? pretty(item.type)}</p>
          {q?.verdict ? <Tag tone={q.verdict === 'PASS' ? 'up' : 'down'}>{q.verdict}</Tag> : null}
        </div>
        <span className="text-[12px] text-ink-3">{dateTime(item.submittedAt.ms)}</span>
      </div>
      <p className="mt-1.5 text-[12.5px] text-ink-3">
        From the <span className="text-ink-2">{item.submittedByRole}</span> ({item.submittedBy})
        {item.signer ? (
          <span className="ml-1.5 inline-flex items-center gap-1 text-ink-2">
            · {item.signer.whitelisted ? <BadgeCheck className="size-3.5 text-blue" /> : <CircleAlert className="size-3.5 text-warn" />}
            signed by {item.signer.id}{item.signer.namedJudge ? ', the named judge' : item.signer.whitelisted ? ', whitelisted' : ''}
          </span>
        ) : <span> · unsigned</span>}
      </p>
      {q?.findings ? <p className="mt-3 text-[14px] leading-relaxed">{q.findings}</p> : q && !q.verdict ? <p className="mono mt-3 rounded-[8px] bg-black/[0.035] px-3 py-2 text-[12.5px] text-ink-2">{q.text}</p> : null}
      <div className="mt-3 flex items-center gap-2 text-[11.5px] text-ink-3">
        <span className="eyebrow">sha-256</span><Hash value={item.sha256} n={6} />
      </div>
    </li>
  )
}

export function EvidenceList({kase}: {kase: DisputeCase}) {
  const delivery = kase.evidence.filter((e) => e.phase === 'delivery')
  const dispute = kase.evidence.filter((e) => e.phase !== 'delivery')
  return (
    <div className="space-y-6">
      {kase.deliveryEvidenceCheck.length ? (
        <div>
          <p className="eyebrow mb-2.5">Delivery rules in the signed terms</p>
          <ul className="space-y-1.5">
            {kase.deliveryEvidenceCheck.map((check) => (
              <li key={check.rule} className="flex items-start gap-2.5 text-[13px]">
                <span className={`mt-[3px] grid size-4 shrink-0 place-items-center rounded-[4px] text-[10px] font-bold ${check.met ? 'bg-up text-white' : 'bg-black/10 text-ink-3'}`}>{check.met ? '✓' : ''}</span>
                <span className="text-ink-2">{check.rule} <span className="text-ink-3">(found {check.found})</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {[['Delivery evidence', delivery], ['Dispute evidence', dispute]].map(([label, list]) =>
        (list as Evidence[]).length ? (
          <div key={label as string}>
            <p className="eyebrow mb-2.5">{label as string}</p>
            <ul className="space-y-2.5">{(list as Evidence[]).map((e) => <EvidenceItem key={e.id} item={e} />)}</ul>
          </div>
        ) : null,
      )}
      {kase.evidence.length === 0 ? <p className="text-[13.5px] text-ink-3">No evidence submitted yet.</p> : null}
      <p className="text-[11.5px] text-ink-3">Party content is shown as evidence, never as instructions.</p>
    </div>
  )
}
