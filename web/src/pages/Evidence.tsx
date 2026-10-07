import {useEffect, useRef, useState, type FormEvent} from 'react'
import {ArrowDownToLine, ArrowUpRight, Check, Circle, LoaderCircle, X} from 'lucide-react'
import {ErrorNote, PageHeader, Tag} from '@/components/kit'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {api} from '@/lib/api'
import {useAsync} from '@/lib/useAsync'
import {atomicToUsdm, parsePaymentClaim, usdmToAtomic} from '../../../packages/evidence/src/payment'
import type {EvidenceResult} from '../../../packages/evidence/src/protocol'

const TITLES = {verified: 'Payment verified', mismatch: 'Payment does not match', pending: 'Waiting for confirmations', not_found: 'Transaction not found'}

function download(result: EvidenceResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'}))
  const link = document.createElement('a')
  link.href = url
  link.download = `tally-evidence-${result.report.claim.txHash}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Result({result}: {result: EvidenceResult}) {
  const {report} = result
  const found = report.status !== 'not_found'
  const rows = [
    {label: 'Transaction', passed: report.checks.transaction, detail: found ? (report.checks.transaction ? 'Included in a valid preprod transaction' : 'The transaction is invalid or the chain data is inconsistent') : 'Not found on Cardano preprod'},
    {label: 'Recipient', passed: report.checks.recipient, detail: found ? (report.checks.recipient ? 'The address received test USDM outputs' : 'No test USDM output to this address') : 'Cannot check yet'},
    {label: 'Amount', passed: report.checks.amount, detail: found ? `${atomicToUsdm(report.receivedAtomic)} net received · ${atomicToUsdm(report.claim.amountAtomic)} expected` : 'Cannot check yet'},
    {label: 'Confirmations', passed: report.checks.confirmations, detail: `${report.confirmations.toLocaleString()} observed · ${report.minimumConfirmations} required`},
  ]
  return (
    <div className="space-y-6" aria-live="polite">
      <div>
        <Tag tone={report.status === 'verified' ? 'up' : report.status === 'mismatch' ? 'down' : 'warn'} className={report.status === 'verified' ? 'text-[#12683c]' : undefined}>{report.status === 'verified' ? 'Matched' : report.status === 'mismatch' ? 'Mismatch' : 'Not verified'}</Tag>
        <h2 className="display mt-3 text-[22px]">{TITLES[report.status]}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          {report.status === 'verified' ? 'The receipt matches the payment details below.' : report.status === 'pending' ? 'The payment matches. Check again after more blocks arrive.' : report.status === 'not_found' ? 'Check the hash and network. A new transaction can take time to appear.' : 'Review the recipient and expected amount. This receipt does not verify the claim.'}
        </p>
      </div>
      <dl className="divide-y divide-black/10">
        {rows.map((row, i) => {
          const unknown = !found && i > 0
          const Icon = row.passed ? Check : unknown || (report.status === 'pending' && i === 3) ? Circle : X
          return (
            <div key={row.label} className="flex gap-3 py-3.5">
              <Icon className={`mt-0.5 size-4 shrink-0 ${row.passed ? 'text-up' : unknown ? 'text-ink-3' : report.status === 'pending' && i === 3 ? 'text-warn' : 'text-down'}`} aria-hidden />
              <div><dt className="text-[13.5px] font-semibold">{row.label}</dt><dd className="mt-1 text-[12.5px] text-ink-2">{row.detail}</dd></div>
            </div>
          )
        })}
      </dl>
      <div className="space-y-2 text-[12px] text-ink-2">
        <p>Checked {new Date(result.checkedAt).toLocaleString()} · Blockfrost</p>
        <p>Chainlink CRE simulation · one node · no DON signature</p>
        <p>The report checks this receipt. It does not confirm delivery or change a contract.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="bg-white" onClick={() => download(result)}><ArrowDownToLine className="size-4" />Download report</Button>
        <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-blue underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue">View transaction<ArrowUpRight className="size-4" /></a>
      </div>
    </div>
  )
}

export function EvidencePage() {
  const info = useAsync(() => api.evidenceInfo(), 'evidence-info')
  const [txHash, setTxHash] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [result, setResult] = useState<EvidenceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const change = (setter: (value: string) => void, value: string) => { setter(value); setResult(null); setError(null) }
  const example = () => {
    const sample = info.data?.example
    if (!sample) return
    setTxHash(sample.txHash); setRecipient(sample.recipient); setAmount(sample.amount); setResult(null); setError(null)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setResult(null); setError(null)
    try {
      const claim = parsePaymentClaim({txHash: txHash.trim().toLowerCase(), recipient: recipient.trim(), amountAtomic: usdmToAtomic(amount.trim())})
      controller.current?.abort()
      const active = new AbortController()
      controller.current = active
      setBusy(true)
      const checked = await api.checkEvidence({txHash: claim.txHash, recipient: claim.recipient, amount: amount.trim()}, active.signal)
      if (!active.signal.aborted) setResult(checked)
    } catch (cause) {
      if (!controller.current?.signal.aborted) setError(cause instanceof Error ? cause.message : 'The check failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Check a payment receipt" description="Use Chainlink to check who received a Cardano preprod payment, how much test USDM arrived, and whether it has enough confirmations." />
      <div className="flex flex-wrap gap-2"><Tag tone="blue">Chainlink CRE simulation</Tag><Tag>Live preprod evidence</Tag><Tag tone="quiet" className="text-ink-2">Read-only</Tag></div>
      <div className="surface overflow-hidden rounded-[16px]">
        <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <form onSubmit={(event) => { void submit(event) }} className="space-y-5 p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[16px] font-semibold">Payment details</h2>
              <Button type="button" variant="outline" size="sm" onClick={example} disabled={busy || !info.data} className="bg-white">Load Masumi receipt</Button>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">The example is a confirmed 1 test USDM Masumi payment. You can also check another receipt.</p>
            <div>
              <label htmlFor="evidence-hash" className="mb-2 block text-[13px] font-medium">Transaction hash</label>
              <Input id="evidence-hash" name="txHash" value={txHash} onChange={(e) => change(setTxHash, e.target.value)} required maxLength={64} disabled={busy} autoComplete="off" spellCheck={false} placeholder="64 hexadecimal characters" className="h-11 bg-white font-mono text-[12px]" />
            </div>
            <div>
              <label htmlFor="evidence-recipient" className="mb-2 block text-[13px] font-medium">Expected recipient</label>
              <Input id="evidence-recipient" name="recipient" value={recipient} onChange={(e) => change(setRecipient, e.target.value)} required maxLength={120} disabled={busy} autoComplete="off" spellCheck={false} placeholder="addr_test1…" className="h-11 bg-white font-mono text-[12px]" />
              <p className="mt-2 break-all text-[11.5px] leading-relaxed text-ink-2">{recipient || 'The address that should receive the payment.'}</p>
            </div>
            <div className="max-w-64">
              <label htmlFor="evidence-amount" className="mb-2 block text-[13px] font-medium">Expected amount · test USDM</label>
              <Input id="evidence-amount" name="amount" value={amount} onChange={(e) => change(setAmount, e.target.value)} required maxLength={20} disabled={busy} inputMode="decimal" placeholder="1.00" className="h-11 bg-white" />
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-2">We compare the net amount received. The recipient’s existing funds and change do not count as a new payment. At least three confirmations are required.</p>
            {info.error || (info.data && !info.data.available) ? <ErrorNote>{info.error ?? 'The evidence checker is offline. Try again later.'}</ErrorNote> : null}
            {error ? <div role="alert"><ErrorNote>{error}</ErrorNote></div> : null}
            <Button type="submit" disabled={busy || !info.data?.available} className="h-11 w-full sm:w-auto">
              {busy ? <><LoaderCircle className="size-4 animate-spin" aria-hidden />Checking receipt…</> : 'Check receipt'}
            </Button>
          </form>
          <div className="border-t border-black/10 bg-white/40 p-5 sm:p-7 lg:border-l lg:border-t-0" aria-busy={busy}>
            {result ? <Result result={result} /> : (
              <div className="flex min-h-64 flex-col justify-center gap-3 lg:min-h-full" role="status">
                {busy ? <LoaderCircle className="size-6 animate-spin text-blue" aria-hidden /> : <Circle className="size-6 text-ink-3" aria-hidden />}
                <h2 className="display text-[21px]">{busy ? 'Checking on-chain evidence' : 'The result appears here'}</h2>
                <p className="max-w-[38ch] text-[13px] leading-relaxed text-ink-2">{busy ? 'Chainlink is reading the transaction, its inputs and outputs, and the current block height. This can take a few seconds.' : 'Load the Masumi receipt, then select Check receipt. Your result will show each check and a report you can download.'}</p>
                <p className="max-w-[40ch] text-[12px] leading-relaxed text-ink-2">This demo runs the real CRE workflow in simulation. It reads live testnet data from Blockfrost. It does not produce a DON signature.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
