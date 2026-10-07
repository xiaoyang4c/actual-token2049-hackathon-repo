import {useState} from 'react'
import {KeyRound, Loader2} from 'lucide-react'
import {ErrorNote} from './kit'
import {Input} from './ui/input'
import {AccountApiError, type Session} from '@/lib/account'
import {walletFromPhrase} from '@/lib/cardano-keys'
import {deriveDealKey, type AppMe, type DealKey} from '@/lib/deals'
import {unlockDeviceWallet} from '@/lib/device-wallet'

/** Derives once per signed action. The seed stays in memory until the request finishes. */
export function DealSigning({session, me, label, work, disabled = false}: {
  session: Session; me: AppMe; label: string; work: (key: DealKey) => Promise<void>; disabled?: boolean
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true); setError(null)
    let key: DealKey | undefined
    try {
      let wallet
      if (session.via === 'browser') {
        const phrase = await unlockDeviceWallet(password)
        if (!phrase) throw new Error('Wrong password, or no wallet saved on this device. Restore your original wallet on Account.')
        wallet = walletFromPhrase(phrase)
      }
      key = await deriveDealKey(session, me, wallet)
      setPassword('')
      await work(key)
    } catch (error) {
      setError(error instanceof AccountApiError && error.code === 'party_exists'
        ? 'A different deal key or payout address is already registered for this account. Use the original wallet. Deal keys cannot be replaced.'
        : error instanceof Error ? error.message : String(error))
    } finally {
      key?.destroy()
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      {session.via === 'browser' ? <label className="block space-y-1.5 text-[13px] text-ink-2">Wallet password on this device
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className="mt-1.5 h-10 max-w-sm bg-white" />
      </label> : null}
      <button type="button" disabled={disabled || busy || (session.via === 'browser' && !password)} onClick={() => void run()}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[9px] bg-ink px-4 py-2 text-[13.5px] font-semibold text-white transition-colors hover:bg-ink-2 disabled:opacity-40">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}{busy ? 'Waiting for your signature…' : label}
      </button>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  )
}
